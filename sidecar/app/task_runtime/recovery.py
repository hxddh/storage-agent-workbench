"""Durable recovery for executions a dead sidecar process left behind.

In-process workers do not survive a restart. A restart stamps every execution
a prior process left ``queued``/``running``/``waiting`` as ``interrupted`` —
an explicit durable state, never silently forgotten.

v2.1 (native agent): recovery then CONTINUES that work on its own. Each
interrupted execution gets one automatic continuation — a new execution that
carries the original Direction and a ``[resume]`` note (the original row keeps
its terminal state; history is never rewritten). The storage tools are
read-only and the one data-moving tool is bounded, so re-running a partial turn
is safe. An execution that was itself an automatic continuation is not resumed
again (no crash loop), and without a usable model the task stays
*Needs attention* with a manual Resume.

Pending Decisions left by pre-2.1 approvals are withdrawn: nothing in the
product can resolve them any more.
"""

from __future__ import annotations

import logging

from ..db import connect
from . import hub, store

_log = logging.getLogger(__name__)


def reconcile_interrupted_executions() -> list[str]:
    """Mark orphaned queued/running/waiting executions interrupted; withdraw
    pending Decisions; refresh their tasks' durable status. Returns the ids of
    the reconciled executions, oldest first. Called from app startup, before
    any new work is accepted."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id, task_id, status FROM task_executions WHERE status IN (?, ?, ?) "
            "ORDER BY rowid ASC",
            (store.EXEC_QUEUED, store.EXEC_RUNNING, store.EXEC_WAITING)).fetchall()
        ids: list[str] = []
        tasks: set[str] = set()
        for r in rows:
            store.set_execution_status(conn, r["id"], store.EXEC_INTERRUPTED,
                                       error="the sidecar process restarted while "
                                             "this execution was in flight")
            store.append_event(conn, r["id"], r["task_id"], "execution.status",
                               {"status": store.EXEC_INTERRUPTED,
                                "reason": "sidecar_restart",
                                "was": r["status"]}, commit=False)
            hub.mark_done(r["id"])
            tasks.add(r["task_id"])
            ids.append(r["id"])
        withdrawn = conn.execute(
            "SELECT DISTINCT task_id FROM task_decisions WHERE status = ?",
            (store.DECISION_PENDING,)).fetchall()
        conn.execute(
            "UPDATE task_decisions SET status = ?, resolved_at = datetime('now'), "
            "resolution_note = COALESCE(resolution_note, 'withdrawn: approvals were "
            "removed in v2.1') WHERE status = ?",
            (store.DECISION_SUPERSEDED, store.DECISION_PENDING))
        tasks.update(r["task_id"] for r in withdrawn)
        for task_id in tasks:
            store.refresh_task_status(conn, task_id)
        conn.commit()
        return ids
    finally:
        conn.close()


def _is_auto_continuation(conn, execution: dict) -> bool:
    """An execution that was already a continuation of interrupted work."""
    if execution.get("kind") != "resume" or not execution.get("resumed_from"):
        return False
    prior = store.get_execution(conn, execution["resumed_from"])
    return bool(prior and prior.get("status") == store.EXEC_INTERRUPTED)


def resume_interrupted(execution_ids: list[str]) -> int:
    """Continue each interrupted execution once, in order. Returns how many
    continuations were submitted. Never raises — startup must not fail on it."""
    if not execution_ids:
        return 0
    from ..agent_runtime.agent_service import AgentUnavailable
    from . import runtime

    conn = connect()
    submitted = 0
    try:
        for exec_id in execution_ids:
            execution = store.get_execution(conn, exec_id)
            if execution is None or execution.get("status") != store.EXEC_INTERRUPTED:
                continue
            if _is_auto_continuation(conn, execution):
                continue
            try:
                runtime.resume(conn, exec_id)
                submitted += 1
            except AgentUnavailable:
                # No usable model: every remaining one would fail the same way;
                # the tasks stay Needs attention with a manual Resume.
                break
            except Exception:  # noqa: BLE001 — recovery is best-effort
                _log.exception("automatic resume failed for execution %s", exec_id)
        return submitted
    finally:
        conn.close()
