"""Run launch orchestration.

A run executes on its own SQLite connection — synchronously via ``run_sync``
(the Agent's session tools and tests) or in a background thread via ``start``
(evidence import's analysis hand-off). No HTTP route creates or starts a run;
progress is the durable ``runs`` / ``tool_calls`` rows, not an event bus.
"""

from __future__ import annotations

import threading

from . import config, db
from .repositories import evidence_imports as evidence_imports_repo
from .repositories import runs as runs_repo
from .runs.access_log_run import execute_access_log_run
from .runs.account_discovery_run import execute_account_discovery_run
from .runs.config_review_run import execute_config_review_run
from .runs.diagnostic import execute_diagnostic_run
from .runs.inventory_run import execute_inventory_run

_EXECUTORS = {
    "diagnostic": execute_diagnostic_run,
    "access_log_analysis": execute_access_log_run,
    "inventory_analysis": execute_inventory_run,
    "bucket_config_review": execute_config_review_run,
    "account_discovery": execute_account_discovery_run,
}


def reconcile_interrupted_runs() -> int:
    """On startup, fail any run left pending/running by a prior process.

    In-process run threads can't survive a restart, so such rows are orphans that
    would otherwise report as forever-running. Evidence imports get the same
    pass: a row still 'importing' is an orphan from a crash mid-download and
    would otherwise be permanently un-re-runnable (its status can never get back
    to 'confirmed'). Called from the app lifespan.
    """
    conn = db.connect()
    try:
        count = runs_repo.mark_interrupted(conn)
        count += evidence_imports_repo.mark_interrupted(conn)
        return count
    finally:
        conn.close()


def run_sync(run_id: str) -> None:
    """Execute a run to completion using a fresh connection.

    Runs are PURE deterministic compute — there is no LLM planner. The
    conversational agent invokes these engines as tools (or proposes a saved
    report); it never plans or narrates inside a run.
    """
    conn = db.connect()
    try:
        row = runs_repo.get_row(conn, run_id)
        if row is None:
            # Deleted in the race window: nothing to execute.
            return
        session_id = row["session_id"]
        executor = _EXECUTORS.get(row["run_type"])
        if executor is None:
            # Unknown run_type: mark the run failed (not left forever-pending) so
            # a reader sees a terminal state with the reason.
            runs_repo.set_status(conn, run_id, "failed",
                                 final_summary=f"run_type '{row['run_type']}' is not executable")
            return
        try:
            executor(conn, run_id)
        except Exception as exc:  # noqa: BLE001 - executor scaffolding failed before its own guard
            # A failure BEFORE the executor's internal try (e.g. get_row raising)
            # would otherwise die silently on this thread, leaving the run pending.
            # Mark it failed with the sanitized reason — scrub_paths too: an
            # OSError/sqlite failure carries the data dir's absolute path.
            from .security.redaction import redact_text
            detail = config.scrub_paths(redact_text(str(exc))).strip()
            try:
                runs_repo.set_status(
                    conn, run_id, "failed",
                    final_summary=(f"Run failed to start. {detail}".strip())[:500])
            except Exception:  # noqa: BLE001 - best effort; never mask the original
                pass
            return
        # After the run finishes, refresh its session's deterministic summary.
        _finalize_session(conn, run_id, session_id)
    finally:
        conn.close()


def _finalize_session(conn, run_id: str, session_id: str | None) -> None:
    """If the run belongs to a session, (re)link it and rebuild the summary.

    Session bookkeeping must never fail the run, so this swallows errors.
    """
    if not session_id:
        return
    try:
        from .repositories import sessions as sessions_repo
        from .sessions import summary_builder
        run = runs_repo.get_row(conn, run_id)
        sessions_repo.link_run(conn, session_id, run_id,
                               sessions_repo.RUN_ROLE.get(run["run_type"]) if run else None)
        summary_builder.refresh(conn, session_id)
    except Exception:  # noqa: BLE001 - never break a run over session bookkeeping
        pass


def start(run_id: str) -> None:
    """Launch a run in a background daemon thread."""
    threading.Thread(target=run_sync, args=(run_id,), daemon=True).start()
