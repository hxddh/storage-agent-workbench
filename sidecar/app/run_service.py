"""Run launch orchestration.

A run executes in a background thread with its own SQLite connection, publishing
events to the in-memory bus. No Redis/Celery/external queue. Tests monkeypatch
``start`` to run synchronously.
"""

from __future__ import annotations

import threading

from . import db
from .events import bus
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
    would otherwise report as forever-running. Called from the app lifespan.
    """
    conn = db.connect()
    try:
        return runs_repo.mark_interrupted(conn)
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
            return
        session_id = row["session_id"]
        executor = _EXECUTORS.get(row["run_type"])
        if executor is None:
            # Unknown run_type: mark the run failed (not left forever-pending) so
            # a reader/UI sees a terminal state, then surface the error + close.
            runs_repo.set_status(conn, run_id, "failed",
                                 final_summary=f"run_type '{row['run_type']}' is not executable")
            bus.publish(run_id, {"type": "error", "message": f"run_type '{row['run_type']}' is not executable"})
            bus.mark_done(run_id)
            return
        try:
            executor(conn, run_id)
        except Exception as exc:  # noqa: BLE001 - executor scaffolding failed before its own guard
            # A failure BEFORE the executor's internal try (e.g. get_row raising)
            # would otherwise die silently on this thread, leaving the run pending
            # and the SSE stream open. Mark it failed and close the stream.
            from .security.redaction import redact_text
            try:
                runs_repo.set_status(conn, run_id, "failed", final_summary="Run failed to start.")
            except Exception:  # noqa: BLE001 - best effort; never mask the original
                pass
            bus.publish(run_id, {"type": "error", "message": redact_text(str(exc))})
            bus.mark_done(run_id)
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
