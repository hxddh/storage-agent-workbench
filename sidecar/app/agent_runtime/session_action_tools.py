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
from .. import audit, run_service
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

# FLOOR on the survey/review final_summary echoed to the model, scaled with the
# model window in build() (same de-ossification as agent memory / thread replay):
# the summary is an already-sanitized deterministic aggregate — no raw rows — so
# clipping it to a flat 2000 chars on a large-window model just made the agent
# narrate a large account from a truncated summary.
_MAX_SUMMARY = 2000
_MAX_SUMMARY_CEIL = 16000


def _err(msg: str) -> str:
    return json.dumps({"error": redact_text(str(msg))[:300]})


# Wall-clock ceiling for an inline run during a chat turn. boto3 already bounds
# each S3 call (connect/read timeout); this bounds the AGGREGATE so a heavy run
# (e.g. account_discovery over a large account) can't make the chat turn appear
# hung indefinitely. On timeout the run keeps going in the background; the tool
# returns the run's current (e.g. "running") status so the agent can move on and
# re-read it later (agent runs are origin='agent' and never shown as a card).
# 180s (was 60): a survey over a real account routinely needs >60s, and the old
# value force-split one investigation across two user turns. The session SSE
# stream emits keepalives during the wait, so the client connection stays alive.
_INLINE_RUN_TIMEOUT = 180.0
# Ceiling on read_run_result's optional in-turn wait (seconds). Lets the agent
# pick up a backgrounded run's result within the SAME turn instead of asking the
# user to send another message. Bounded so a wait can't hang a turn.
_MAX_RESULT_WAIT = 60


def _execute_run(conn: sqlite3.Connection, body: RunCreate,
                 turn_id: str | None = None, dedup_key: str | None = None,
                 cancel_event: Any = None) -> str:
    """Create + run a read-only run and return its id, bounded by a wall clock.

    Commits so ``run_service.run_sync`` (which uses its own connection) sees the
    row, then runs it on a daemon thread and waits up to ``_INLINE_RUN_TIMEOUT``.
    If ``cancel_event`` fires (the user stopped the turn) the wait ends early —
    the run itself keeps completing in the background like a timeout would.

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
    import time as _time
    deadline = _time.monotonic() + _INLINE_RUN_TIMEOUT
    while not done.is_set() and _time.monotonic() < deadline:
        if cancel_event is not None and cancel_event.is_set():
            break  # user stopped the turn — return the run's current status now
        done.wait(1.0)
    conn.commit()  # end any read snapshot so the re-read sees run_sync's writes
    return run_id


def _run_result(conn: sqlite3.Connection, run_id: str,
                summary_cap: int = _MAX_SUMMARY) -> dict[str, Any]:
    row = runs_repo.get_row(conn, run_id)
    if row is None:
        return {"run_id": run_id, "status": "unknown"}
    summary = row["final_summary"] or ""
    result: dict[str, Any] = {
        "run_id": run_id,
        "status": row["status"],
        "final_summary": redact_text(str(summary))[:summary_cap],
    }
    if row["status"] in ("pending", "running"):
        # Hit the wall-clock timeout: the run is still going in the background.
        # Tell the agent NOT to draw conclusions from this incomplete result.
        result["note"] = (
            "This run is still in progress (it exceeded the inline time budget and "
            "continues in the background). Do NOT state findings from it yet — tell "
            "the user it is still running, then in a LATER turn call "
            f"read_run_result(run_id='{run_id}') to read the completed result. Do "
            "NOT re-run the survey/review — that only restarts the same work."
        )
    return result


def build(
    conn: sqlite3.Connection,
    function_tool: Callable,
    activity: list[dict[str, Any]] | None = None,
    session_id: str | None = None,
    turn_id: str | None = None,
    cancel_event: Any = None,
    model: str | None = None,
    explicit_window: int | None = None,
) -> list[Any]:
    """Build the agent's read-only survey/review tools (always available).

    These run the deterministic engine and persist an account profile (so the
    evidence-import and summary flows keep working), but the run is recorded with
    ``origin='agent'`` and is NEVER surfaced as a structured run card in the
    thread — the agent narrates the result. They are read-only and bounded; there
    is no autonomy toggle and nothing data-moving here.

    ``turn_id`` (the client turn id) makes a survey/review idempotent across a
    streaming attempt and its blocking fallback (see ``turn_guard``).
    ``cancel_event`` lets the 180 s inline-run wait return early when the user
    stops the turn.
    """
    from . import model_budget

    # Elastic summary echo: floor at _MAX_SUMMARY (128k/200k windows unchanged),
    # scaled with the window like agent memory / thread replay.
    window = model_budget.context_window(model, explicit_window)
    summary_cap = min(_MAX_SUMMARY_CEIL, _MAX_SUMMARY * max(1, window // 128_000))

    def provider(provider_id: str):
        return cloud_repo.get(conn, provider_id)

    def provider_name(provider_id: str) -> str:
        p = cloud_repo.get(conn, provider_id)
        return p.name if p else provider_id[:8]

    def bucket_ok(p, bucket: str) -> bool:
        return (not p.allowed_buckets) or (bucket in p.allowed_buckets)

    def start(tool: str, target: str) -> None:
        # Emit a START marker so the live stream can show "running <tool>…"
        # while the (slow) inline run executes. Only "completed" records persist.
        if activity is not None:
            activity.append({"tool": tool, "target": target[:80], "status": "started"})

    def note(tool: str, target: str, result: str) -> None:
        if activity is not None:
            activity.append({"tool": tool, "target": target[:80], "result": result[:80],
                             "status": "completed"})

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
        start("review_bucket_config", bucket)
        try:
            body = RunCreate(run_type="bucket_config_review", provider_id=provider_id, bucket=bucket,
                             user_prompt=_DEFAULT_PROMPTS["bucket_config_review"], session_id=session_id)
            run_id = _execute_run(conn, body, turn_id, f"bucket_config_review:{provider_id}:{bucket}",
                                  cancel_event=cancel_event)
            result = _run_result(conn, run_id, summary_cap)
        except Exception as exc:  # noqa: BLE001 — a tool returns an error string, never raises
            return _err(f"review_bucket_config failed: {exc}")
        note("review_bucket_config", bucket, result["status"])
        return json.dumps(result)

    @function_tool
    def survey_account(provider_id: str, max_buckets: int = 0) -> str:
        """Read-only account survey: enumerate visible buckets and detect evidence sources (access logs, inventory) across the account, persisting a profile the evidence-import flow can use. This is the COSTLY account tool — it makes live S3 calls across every visible bucket. Prefer the cheap persisted-profile readers when they can answer: query_account_profile for cross-bucket posture ("which buckets are public / unencrypted / no lifecycle?") and compare_to_last_survey for "what changed" both read the LAST survey with no new S3 calls. Run this only to establish a first profile or deliberately refresh a stale one. Returns a compact summary (counts + summary + public-exposure note), not raw key lists, for you to narrate. Does NOT surface a separate card. Use only when the user's request is about the account/buckets — NOT for local-file analysis or unrelated questions. The result includes has_prior_survey — when true, call compare_to_last_survey next to report what changed. max_buckets (optional, 1-2000) raises the per-survey bucket cap for large accounts (default 100); the result's truncated flag tells you if buckets were left out. Args: provider_id; max_buckets?."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Use a configured provider.")
        # Was there a survey BEFORE this one? (Checked before running, so the
        # run we're about to create doesn't count itself.)
        had_prior = bool(account_repo.recent_run_ids_for_provider(conn, provider_id, 1))
        start("survey_account", provider_name(provider_id))
        try:
            mb = max(1, min(int(max_buckets), 2000)) if max_buckets else None
            body = RunCreate(run_type="account_discovery", provider_id=provider_id,
                             user_prompt=_DEFAULT_PROMPTS["account_discovery"],
                             session_id=session_id, max_buckets=mb)
            run_id = _execute_run(conn, body, turn_id, f"account_discovery:{provider_id}",
                                  cancel_event=cancel_event)
            result = _run_result(conn, run_id, summary_cap)
            profile = account_repo.get_profile(conn, run_id)
        except Exception as exc:  # noqa: BLE001 — a tool returns an error string, never raises
            return _err(f"survey_account failed: {exc}")
        if profile:
            result["bucket_count"] = profile.get("bucket_count")
            result["visible_count"] = profile.get("visible_count")
            result["truncated"] = profile.get("truncated")
        result["has_prior_survey"] = had_prior
        if had_prior:
            result["next_step"] = ("A prior survey exists — call compare_to_last_survey "
                                   "to report what changed (including any bucket that "
                                   "became public).")
        note("survey_account", provider_name(provider_id), result["status"])
        return json.dumps(result)

    @function_tool
    def read_run_result(run_id: str, wait_seconds: int = 0) -> str:
        """Read the current status + sanitized summary of a run already linked to this session — e.g. a survey/review that exceeded the inline time budget and finished in the background, or an evidence-import analysis. Set wait_seconds (up to 60) to wait in-turn for a still-running run to finish instead of asking the user to send another message; 0 returns immediately. Returns status + final_summary (no raw rows/keys). Args: run_id; wait_seconds (optional)."""
        import time as _time

        from ..repositories import sessions as sessions_repo
        linked = {r["run_id"] for r in sessions_repo.list_runs(conn, session_id)} if session_id else set()
        if run_id not in linked:
            return _err("Unknown run_id for this session. Only runs in this session can be read.")
        result = _run_result(conn, run_id, summary_cap)
        # Bounded in-turn wait: poll until the run leaves pending/running or the
        # budget elapses. This whole turn already runs on a dedicated worker
        # thread (boto3 tools block it by design), so sleeping here stalls only
        # this session's turn — the SSE keepalive keeps the client alive.
        deadline = _time.monotonic() + max(0, min(int(wait_seconds), _MAX_RESULT_WAIT))
        while result["status"] in ("pending", "running") and _time.monotonic() < deadline:
            if cancel_event is not None and cancel_event.is_set():
                break  # user stopped the turn — stop waiting on the background run
            _time.sleep(1.0)
            conn.commit()  # end the read snapshot so run_sync's writes are visible
            result = _run_result(conn, run_id, summary_cap)
        audit.record(conn, "session.read_run_result",
                     {"session_id": session_id, "run_id": run_id, "status": result["status"]},
                     run_id=run_id)
        conn.commit()
        note("read_run_result", run_id[:8], result["status"])
        return json.dumps(result)

    @function_tool
    def compare_to_last_survey(provider_id: str) -> str:
        """Read-only: what CHANGED between this provider's two most recent account surveys — buckets added/removed, per-bucket config changes (versioning / encryption / lifecycle / logging / replication / policy / public-access / tagging / inventory), and evidence-source changes. Answers "what changed since last time?" from ALREADY-PERSISTED survey data — no new S3 calls, no LLM. Needs two completed surveys to exist (run survey_account now and it compares against the previous one). Args: provider_id."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Use a configured provider.")
        try:
            run_ids = account_repo.recent_run_ids_for_provider(conn, provider_id, 2)
            if len(run_ids) < 2:
                note("compare_to_last_survey", provider_name(provider_id), "no prior")
                return json.dumps({
                    "success": True, "comparable": False,
                    "note": ("Only one (or no) account survey exists for this provider, so there is "
                             "nothing to compare against yet. Run survey_account now; a later survey "
                             "can then be compared to this one."),
                })
            new_p = account_repo.get_profile(conn, run_ids[0])
            old_p = account_repo.get_profile(conn, run_ids[1])
            if not new_p or not old_p:
                return _err("Could not load the two surveys to compare.")
            diff = account_repo.diff_profiles(old_p, new_p)
        except Exception as exc:  # noqa: BLE001 — a tool returns an error string, never raises
            return _err(f"compare_to_last_survey failed: {exc}")
        audit.record(conn, "session.compare_to_last_survey",
                     {"provider_id": provider_id, "change_count": diff.get("change_count")},
                     run_id=None)
        conn.commit()
        note("compare_to_last_survey", provider_name(provider_id), f"{diff['change_count']} change(s)")
        return json.dumps({
            "success": True, "comparable": True,
            "newer_survey": {"run_id": run_ids[0], "at": new_p.get("created_at")},
            "older_survey": {"run_id": run_ids[1], "at": old_p.get("created_at")},
            **diff,
        })

    @function_tool
    def query_account_profile(provider_id: str, filter: str = "all") -> str:
        """Read-only: query the MOST RECENT persisted account survey for a cross-bucket posture matrix — answers "which of my buckets are public / have no encryption / no public-access-block / no lifecycle / logging off?" across the whole account WITHOUT re-scanning. Reads ALREADY-PERSISTED, sanitized snapshot flags (no new S3 call, no LLM, no object keys/bodies — statuses only). Returns, per matching bucket, its region + config-flag statuses (versioning/encryption/lifecycle/logging/replication/policy/public_access_block/tagging/inventory + access + policy_is_public/object_ownership). `filter` ∈ all | public_buckets (publicly exposed via the bucket POLICY verdict AND/OR public ACL grants) | missing_public_access_block | missing_encryption | missing_lifecycle | missing_logging | no_versioning | access_issues. Needs a completed survey_account first (run it if none exists; surveys before v0.29.0 lack the public-posture flags — re-survey to fill them). Args: provider_id, filter? (default 'all')."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Use a configured provider.")
        allowed = {"all", "public_buckets", "missing_public_access_block", "missing_encryption",
                   "missing_lifecycle", "missing_logging", "no_versioning", "access_issues"}
        if filter not in allowed:
            return _err(f"Unknown filter '{filter}'. Choose one of: {', '.join(sorted(allowed))}.")
        try:
            run_ids = account_repo.recent_run_ids_for_provider(conn, provider_id, 1)
            if not run_ids:
                note("query_account_profile", provider_name(provider_id), "no survey")
                return json.dumps({
                    "success": True, "has_survey": False,
                    "note": ("No account survey exists for this provider yet. Run survey_account "
                             "first; then this can answer account-wide posture questions from it."),
                })
            prof = account_repo.get_profile(conn, run_ids[0])
            if not prof:
                return _err("Could not load the latest account survey.")
        except Exception as exc:  # noqa: BLE001 — a tool returns an error string, never raises
            return _err(f"query_account_profile failed: {exc}")

        # These are the sanitized, scalar status/bool fields the snapshot persists
        # (same set diff_profiles compares) — never a key, ARN, or object body.
        _FLAGS = ("region", "access_status", "head_bucket_status", "versioning_status",
                  "versioning_enabled", "encryption_status", "lifecycle_status",
                  "logging_status", "logging_enabled", "replication_status", "policy_status",
                  "public_access_block_status", "tagging_status", "inventory_status",
                  "policy_public_status", "policy_is_public", "ownership_status",
                  "object_ownership", "acls_disabled", "acl_status", "acl_public",
                  "publicly_exposed")
        _NC = "not_configured"

        def matches(b: dict[str, Any]) -> bool:
            if filter == "all":
                return True
            if filter == "missing_public_access_block":
                return b.get("public_access_block_status") == _NC
            if filter == "missing_encryption":
                return b.get("encryption_status") == _NC
            if filter == "missing_lifecycle":
                return b.get("lifecycle_status") == _NC
            if filter == "missing_logging":
                # Only "confirmed absent" — NOT provider_unsupported/access_denied,
                # where logging_enabled is also False but the truth is UNKNOWN.
                return b.get("logging_status") == _NC
            if filter == "no_versioning":
                return b.get("versioning_status") == _NC
            if filter == "public_buckets":
                # Combined exposure (policy verdict OR ACL grants) when the
                # survey recorded it; policy verdict alone as fallback for
                # surveys from before the ACL read existed. None = unknown.
                return (b.get("publicly_exposed") is True
                        or b.get("policy_is_public") is True
                        or b.get("acl_public") is True)
            if filter == "access_issues":
                # The survey persists access_status as "available" (healthy),
                # "access_denied", or "error" — never "ok"/"accessible". Match the
                # real problem values, not the absence of guessed-healthy ones.
                return (b.get("access_status") in ("access_denied", "error")
                        or b.get("head_bucket_status") in ("access_denied", "error"))
            return True

        buckets = prof.get("buckets") or []
        rows = [{"bucket": b.get("bucket_name"), **{k: b.get(k) for k in _FLAGS}}
                for b in buckets if matches(b)]
        audit.record(conn, "session.query_account_profile",
                     {"session_id": session_id, "provider_id": provider_id,
                      "filter": filter, "matched": len(rows)}, run_id=None)
        conn.commit()
        note("query_account_profile", provider_name(provider_id),
             f"{len(rows)}/{len(buckets)} match '{filter}'")
        return json.dumps({
            "success": True, "has_survey": True,
            "survey_run_id": run_ids[0], "surveyed_at": prof.get("created_at"),
            # Honesty: a truncated survey means this matrix is PARTIAL — say so
            # instead of silently answering over a subset of the account.
            "survey_truncated": bool(prof.get("truncated")),
            "filter": filter, "total_buckets": len(buckets),
            "matched_count": len(rows), "buckets": rows,
        })

    return [review_bucket_config, survey_account, read_run_result,
            compare_to_last_survey, query_account_profile]


__all__ = ["build"]
