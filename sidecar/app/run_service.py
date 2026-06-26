"""Run launch orchestration (Phase 04/05).

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
from .runs.config_review_run import execute_config_review_run
from .runs.diagnostic import execute_diagnostic_run
from .runs.inventory_run import execute_inventory_run

_EXECUTORS = {
    "diagnostic": execute_diagnostic_run,
    "access_log_analysis": execute_access_log_run,
    "inventory_analysis": execute_inventory_run,
    "bucket_config_review": execute_config_review_run,
}

# Dataset-analysis run types handle Agent mode INSIDE their deterministic
# executor (Phase 13): deterministic analysis runs first, then an
# interpretation-only narrator over the sanitized aggregates. They must NOT be
# dispatched to the tool-calling ``run_agent`` planner.
_AGENT_VIA_EXECUTOR = {"access_log_analysis", "inventory_analysis"}


def run_sync(run_id: str) -> None:
    """Execute a run to completion using a fresh connection.

    Dispatched by planner_mode first (agent vs deterministic), then by run_type.
    Dataset-analysis run types always go through their executor, which performs
    the deterministic analysis and (in agent mode) the interpretation narrator.
    """
    conn = db.connect()
    try:
        row = runs_repo.get_row(conn, run_id)
        if row is None:
            return
        if row["planner_mode"] == "agent" and row["run_type"] not in _AGENT_VIA_EXECUTOR:
            # Controlled LLM planner over the same whitelisted tools.
            from .agent_runtime.agent_service import run_agent
            run_agent(conn, run_id)
            return
        executor = _EXECUTORS.get(row["run_type"])
        if executor is None:
            bus.publish(run_id, {"type": "error", "message": f"run_type '{row['run_type']}' is not executable"})
            bus.mark_done(run_id)
            return
        executor(conn, run_id)
    finally:
        conn.close()


def start(run_id: str) -> None:
    """Launch a run in a background daemon thread."""
    threading.Thread(target=run_sync, args=(run_id,), daemon=True).start()
