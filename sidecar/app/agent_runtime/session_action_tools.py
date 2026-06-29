"""Read-only SURVEY/REVIEW tools the in-chat agent runs itself.

These run the heavier deterministic compute — an account survey (enumerate
buckets + detect evidence sources) and a bucket config review — that would be
clumsy to reproduce probe-by-probe. They exist so the agent can fold a complete
account/config picture into its answer. There is no autonomy toggle: they are
always available because they are read-only and bounded. Connectivity/credential/
addressing diagnosis is deliberately NOT here — the agent does that adaptively
with its own read-only session tools.

Each survey/review:
- runs the same whitelisted read-only path as a manual run and persists an
  account profile (so the evidence-import and summary flows keep working);
- is recorded with ``origin='agent'`` and is NEVER surfaced as a structured run
  card in the thread — the agent narrates the result in its own words;
- returns only the run's sanitized ``final_summary`` + compact counts to the
  model — never raw rows, keys, or bodies;
- nothing here is data-moving or mutating.
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
    "bucket_config_review": "Review this bucket's security, lifecycle, observability and cost configuration.",
    "account_discovery": "Discover account-level buckets and evidence sources.",
}

_MAX_SUMMARY = 2000


def _err(msg: str) -> str:
    return json.dumps({"error": redact_text(str(msg))[:300]})


# Wall-clock ceiling for an inline run during a chat turn. boto3 already bounds
# each S3 call (connect/read timeout); this bounds the AGGREGATE so a heavy run
# (e.g. account_discovery over a large account) can't make the chat turn appear
# hung indefinitely. On timeout the run keeps going in the background; the tool
# returns the run's current (e.g. "running") status so the agent can move on and
# re-read it later (agent runs are origin='agent' and never shown as a card).
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
    run_id = runs_repo.create(conn, body, status="pending", origin="agent")
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
            "This survey is still in progress (it exceeded the inline time budget "
            "and continues in the background). Do NOT state findings from it yet — "
            "tell the user it is still running and revisit it (call this tool "
            "again) in a later turn to read the completed result."
        )
    return result


def build(
    conn: sqlite3.Connection,
    function_tool: Callable,
    activity: list[dict[str, Any]] | None = None,
    session_id: str | None = None,
    turn_id: str | None = None,
) -> list[Any]:
    """Build the agent's read-only survey/review tools (always available).

    These run the deterministic engine and persist an account profile (so the
    evidence-import and summary flows keep working), but the run is recorded with
    ``origin='agent'`` and is NEVER surfaced as a structured run card in the
    thread — the agent narrates the result. They are read-only and bounded; there
    is no autonomy toggle and nothing data-moving here.

    ``turn_id`` (the client turn id) makes a survey/review idempotent across a
    streaming attempt and its blocking fallback (see ``turn_guard``).
    """
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

    # NOTE: connectivity/credential/addressing diagnosis is NOT a tool here — the
    # agent does that adaptively with its own read-only session_tools probes
    # (test_credentials → test_addressing_style / inspect_endpoint_tls /
    # head_bucket / list_objects / test_range_get). These two tools exist only to
    # run the heavier deterministic SURVEY/REVIEW compute (which persists a profile
    # for evidence/summary) without surfacing a run card.

    @function_tool
    def review_bucket_config(provider_id: str, bucket: str) -> str:
        """Read-only review of one bucket's configuration (security, lifecycle, observability, cost, performance). Runs the deterministic config-review engine and returns its findings for you to interpret and narrate. Does NOT surface a separate card — fold the findings into your own answer. Use only when the user's request is about this bucket's configuration. Args: provider_id, bucket."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Use a configured provider.")
        if not bucket_ok(p, bucket):
            return _err("That bucket is not in this provider's allow-list.")
        body = RunCreate(run_type="bucket_config_review", provider_id=provider_id, bucket=bucket,
                         user_prompt=_DEFAULT_PROMPTS["bucket_config_review"], session_id=session_id)
        run_id = _execute_run(conn, body, turn_id, f"bucket_config_review:{provider_id}:{bucket}")
        result = _run_result(conn, run_id)
        note("review_bucket_config", bucket, result["status"])
        return json.dumps(result)

    @function_tool
    def survey_account(provider_id: str) -> str:
        """Read-only account survey: enumerate visible buckets and detect evidence sources (access logs, inventory) across the account, persisting a profile the evidence-import flow can use. Returns a compact summary (counts + summary), not raw key lists, for you to narrate. Does NOT surface a separate card. Use only when the user's request is about the account/buckets — NOT for local-file analysis or unrelated questions. Args: provider_id."""
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
        note("survey_account", provider_name(provider_id), result["status"])
        return json.dumps(result)

    return [review_bucket_config, survey_account]


__all__ = ["build"]
