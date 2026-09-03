"""Durable recovery for executions a dead sidecar process left behind.

In-process workers do not survive a restart. Before this runtime existed, that
truth was silent: the turn registry was memory, so a restart reported "nothing
running" and the work simply vanished. Now the executions are rows, and a
restart stamps every one a prior process left ``queued``/``running``/``waiting``
as ``interrupted`` — an explicit durable state with an explicit affordance
(resume).

``waiting`` is included deliberately (v1.13): its tool thread blocked on an
in-process approval Event that died with the process, so no worker remains to
continue the gated action on resolve. Leaving it ``waiting`` let a later Allow
settle the execution as completed WITHOUT the import/scan ever running. The
pending Decision row itself is untouched (the user's boundary stands); Resume
starts a new execution that re-plans and re-raises it.
"""

from __future__ import annotations

from ..db import connect
from . import hub, store


def reconcile_interrupted_executions() -> int:
    """Mark orphaned queued/running executions interrupted; refresh their
    tasks' durable status. Returns how many were reconciled. Called from app
    startup, before any new work is accepted."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id, task_id, status FROM task_executions WHERE status IN (?, ?, ?)",
            (store.EXEC_QUEUED, store.EXEC_RUNNING, store.EXEC_WAITING)).fetchall()
        count = 0
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
            count += 1
        for task_id in tasks:
            store.refresh_task_status(conn, task_id)
        conn.commit()
        return count
    finally:
        conn.close()
