"""Action tools the in-chat agent can EXECUTE itself (Phase 1 autonomy).

These close the old proposal→execution gap: instead of only *proposing* a
read-only run for the user to re-drive through a form, the agent — when the
autonomy policy allows inline execution — can run it and fold the findings into
its answer. Only SAFE_READONLY runs live here (diagnostic,
bucket_config_review, account_discovery); expensive/data-moving work
(analysis, evidence import) is never auto-run and stays a proposal.

Every run created here is:
- a REAL, persisted, audited run (identical to a manual one) bound to the
  session, so it appears in the timeline and the run detail;
- read-only and deterministic — it uses the same whitelisted read-only S3 path
  as the manual run; no new capability and nothing mutating is reachable;
- bounded in what it returns to the model: only the run's already-sanitized
  ``final_summary`` plus compact counts — never raw rows, keys, or bodies.

The tools are only added to the agent's toolset when ``autonomy.executes_inline``
is true for the active policy (see ``session_tools`` / ``session_agent``).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any, Callable

from . import turn_guard
from .. import run_service
from ..events import bus
from ..models.schemas import RunCreate
from ..repositories import account_discovery as account_repo
from ..repositories import cloud_providers as cloud_repo
from ..repositories import runs as runs_repo
from ..security.redaction import redact_text

# Run types the agent may execute inline, with the prompt used when it does.
_DEFAULT_PROMPTS = {
    "diagnostic": "Diagnose connectivity, credentials, and addressing for this bucket.",
    "bucket_config_review": "Review this bucket's security, lifecycle, observability and cost configuration.",
    "account_discovery": "Discover account-level buckets and evidence sources.",
}

_MAX_SUMMARY = 2000


def _err(msg: str) -> str:
    return json.dumps({"error": redact_text(str(msg))[:300]})


# Wall-clock ceiling for an inline run during a chat turn. boto3 already bounds
# each S3 call (connect/read timeout); this bounds the AGGREGATE so a heavy run
# (e.g. account_discovery over a large account) can't make the chat turn appear
# hung indefinitely. On timeout the run keeps going in the background and lands
# in the session timeline; the tool returns the run's current (e.g. "running")
# status so the agent can move on.
_INLINE_RUN_TIMEOUT = 60.0


def _execute_run(conn: sqlite3.Connection, body: RunCreate,
                 turn_id: str | None = None, dedup_key: str | None = None) -> str:
    """Create + run a read-only run and return its id, bounded by a wall clock.

    Commits so ``run_service.run_sync`` (which uses its own connection) sees the
    row, then runs it on a daemon thread and waits up to ``_INLINE_RUN_TIMEOUT``.

    Idempotency: if this turn already created a run with ``dedup_key`` (e.g. a
    streaming attempt that then errored, triggering the blocking fallback), reuse
    that run instead of creating a duplicate.
    """
    if turn_id and dedup_key:
        existing = turn_guard.get_run(turn_id, dedup_key)
        if existing:
            return existing
    run_id = runs_repo.create(conn, body, status="pending")
    if body.session_id:
        from ..repositories import sessions as sessions_repo
        sessions_repo.link_run(conn, body.session_id, run_id,
                               sessions_repo.RUN_ROLE.get(body.run_type))
    conn.commit()
    if turn_id and dedup_key:
        turn_guard.set_run(turn_id, dedup_key, run_id)
    bus.create(run_id)

    done = threading.Event()

    def _go() -> None:
        try:
            run_service.run_sync(run_id)  # its own connection
        finally:
            done.set()

    threading.Thread(target=_go, name=f"inline-run-{run_id[:8]}", daemon=True).start()
    done.wait(_INLINE_RUN_TIMEOUT)
    conn.commit()  # end any read snapshot so the re-read sees run_sync's writes
    return run_id


def _run_result(conn: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    row = runs_repo.get_row(conn, run_id)
    if row is None:
        return {"run_id": run_id, "status": "unknown"}
    summary = row["final_summary"] or ""
    result: dict[str, Any] = {
        "run_id": run_id,
        "status": row["status"],
        "final_summary": redact_text(str(summary))[:_MAX_SUMMARY],
    }
    if row["status"] in ("pending", "running"):
        # Hit the wall-clock timeout: the run is still going in the background.
        # Tell the agent NOT to draw conclusions from this incomplete result.
        result["note"] = (
            "This run is still in progress (it exceeded the inline time budget and "
            "continues in the background; it will appear complete in the session "
            "timeline). Do NOT state findings from it yet — tell the user it is "
            "still running, or revisit it in a later turn."
        )
    return result


def build(
    conn: sqlite3.Connection,
    function_tool: Callable,
    policy: str,
    activity: list[dict[str, Any]] | None = None,
    session_id: str | None = None,
    turn_id: str | None = None,
) -> list[Any]:
    """Build the inline-execution tool set. Empty unless the policy allows it.

    ``turn_id`` (the client turn id) makes inline runs idempotent across a
    streaming attempt and its blocking fallback (see ``turn_guard``).
    """
    from . import autonomy
    if not autonomy.executes_inline(policy):
        return []

    def provider(provider_id: str):
        return cloud_repo.get(conn, provider_id)

    def provider_name(provider_id: str) -> str:
        p = cloud_repo.get(conn, provider_id)
        return p.name if p else provider_id[:8]

    def bucket_ok(p, bucket: str) -> bool:
        return (not p.allowed_buckets) or (bucket in p.allowed_buckets)

    def note(tool: str, target: str, result: str) -> None:
        if activity is not None:
            activity.append({"tool": tool, "target": target[:80], "result": result[:80]})

    @function_tool
    def run_diagnostic(provider_id: str, bucket: str) -> str:
        """Execute a read-only diagnostic run on a bucket (credentials, reachability, addressing, TLS, range) and return its findings. This actually RUNS and records the run — use it to confirm a hypothesis, not just to suggest it. Args: provider_id, bucket."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Use a configured provider.")
        if not bucket_ok(p, bucket):
            return _err("That bucket is not in this provider's allow-list.")
        body = RunCreate(run_type="diagnostic", provider_id=provider_id, bucket=bucket,
                         user_prompt=_DEFAULT_PROMPTS["diagnostic"], session_id=session_id)
        run_id = _execute_run(conn, body, turn_id, f"diagnostic:{provider_id}:{bucket}")
        result = _run_result(conn, run_id)
        note("run_diagnostic", bucket, result["status"])
        return json.dumps(result)

    @function_tool
    def run_bucket_config_review(provider_id: str, bucket: str) -> str:
        """Execute a read-only bucket configuration review (security, lifecycle, observability, cost, performance) and return its findings. Actually RUNS and records the run. Args: provider_id, bucket."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Use a configured provider.")
        if not bucket_ok(p, bucket):
            return _err("That bucket is not in this provider's allow-list.")
        body = RunCreate(run_type="bucket_config_review", provider_id=provider_id, bucket=bucket,
                         user_prompt=_DEFAULT_PROMPTS["bucket_config_review"], session_id=session_id)
        run_id = _execute_run(conn, body, turn_id, f"bucket_config_review:{provider_id}:{bucket}")
        result = _run_result(conn, run_id)
        note("run_bucket_config_review", bucket, result["status"])
        return json.dumps(result)

    @function_tool
    def run_account_discovery(provider_id: str) -> str:
        """Execute a read-only account discovery run: enumerate buckets and detect evidence sources (access logs, inventory) across the account. Actually RUNS and records the run; returns a compact summary (counts + final summary), not raw key lists. Args: provider_id."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Use a configured provider.")
        body = RunCreate(run_type="account_discovery", provider_id=provider_id,
                         user_prompt=_DEFAULT_PROMPTS["account_discovery"], session_id=session_id)
        run_id = _execute_run(conn, body, turn_id, f"account_discovery:{provider_id}")
        result = _run_result(conn, run_id)
        profile = account_repo.get_profile(conn, run_id)
        if profile:
            result["bucket_count"] = profile.get("bucket_count")
            result["visible_count"] = profile.get("visible_count")
        note("run_account_discovery", provider_name(provider_id), result["status"])
        return json.dumps(result)

    return [run_diagnostic, run_bucket_config_review, run_account_discovery]


__all__ = ["build"]
