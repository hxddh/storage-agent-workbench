"""Startup data maintenance — bounded reclamation for long-lived installs.

The app writes local artifacts (per-run directories) and append-only rows
(``audit_logs``, ad-hoc ``tool_calls``, ``execution_events``) that otherwise
grow without bound over months of daily use. This runs once at startup and is
deliberately conservative:

- It only deletes the INTERNAL ('agent'-origin) runs of sessions that no longer
  exist — never a user-authored report run, never a run of a live session.
- It ages out the write-only audit trail past a generous retention window (a
  full year by default), satisfying "tool calls are recorded" while bounding
  growth. Set ``STORAGE_AGENT_AUDIT_RETENTION_DAYS=0`` to keep everything.
- It prunes ``execution_events`` only for TERMINAL executions (completed /
  failed / cancelled / interrupted), under dual caps (age + per-execution
  count). Truncation always leaves an explicit ``execution.events_truncated``
  marker event — never silent. Active and waiting executions are never touched.
  Set ``STORAGE_AGENT_EXECUTION_EVENT_RETENTION_DAYS=0`` and
  ``STORAGE_AGENT_EXECUTION_EVENT_MAX_PER_EXECUTION=0`` to keep every event.

Everything here is best-effort: a failure to remove a directory or prune a row is
logged-by-return-count, never fatal to startup.
"""

from __future__ import annotations

import os
import shutil
from datetime import datetime, timedelta, timezone

from . import config
from .db import connect
from .repositories import runs as runs_repo
from .task_runtime import store

_DEFAULT_AUDIT_RETENTION_DAYS = 365
_DEFAULT_EVENT_RETENTION_DAYS = 30
_DEFAULT_EVENT_MAX_PER_EXECUTION = 2000
_EVENT_TRUNCATED_TYPE = "execution.events_truncated"


def _audit_retention_days() -> int:
    raw = os.environ.get("STORAGE_AGENT_AUDIT_RETENTION_DAYS")
    if raw is None:
        return _DEFAULT_AUDIT_RETENTION_DAYS
    try:
        return max(0, int(raw))
    except ValueError:
        return _DEFAULT_AUDIT_RETENTION_DAYS


def _remove_run_dirs(run_ids: list[str]) -> None:
    for rid in run_ids:
        shutil.rmtree(config.run_dir(rid), ignore_errors=True)


def sweep_orphaned_agent_runs(conn) -> int:
    """Delete 'agent'-origin runs whose session is gone (rows + on-disk dirs)."""
    ids = runs_repo.orphaned_agent_run_ids(conn)
    for rid in ids:
        runs_repo.delete(conn, rid)
    _remove_run_dirs(ids)
    return len(ids)


def prune_audit_logs(conn) -> int:
    """Age out audit rows and genuinely OWNERLESS tool_calls past the window.

    A ``tool_calls`` row is reachable through its run (cascades on run delete) or
    through its session (cascade-equivalent: the session's own delete path). Only
    rows with NEITHER owner — ad-hoc Test-Connection-style probes — are
    unreachable forever, and only those may be aged out here.

    The ``session_id IS NULL`` half of that predicate is load-bearing. Before it,
    the sweep matched ``run_id IS NULL`` alone, which from v0.45.0 also describes
    every tool call the conversational agent makes: the sweep silently destroyed
    a LIVE session's rule-17 tool trace, leaving the inspector's timeline empty
    while ``turn_metrics`` still reported the calls — two numbers in one UI
    disagreeing, with the evidence gone.

    Audit rows are pruned by age regardless of owner: they are an append-only
    trail with a retention window by design, and the window is what bounds them.

    Returns the number of audit rows removed."""
    days = _audit_retention_days()
    if days <= 0:
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    n = conn.execute("DELETE FROM audit_logs WHERE created_at < ?", (cutoff,)).rowcount
    conn.execute(
        "DELETE FROM tool_calls "
        "WHERE run_id IS NULL AND session_id IS NULL AND created_at < ?",
        (cutoff,),
    )
    conn.commit()
    return n


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


def _event_retention_days() -> int:
    return _int_env("STORAGE_AGENT_EXECUTION_EVENT_RETENTION_DAYS",
                    _DEFAULT_EVENT_RETENTION_DAYS)


def _event_max_per_execution() -> int:
    return _int_env("STORAGE_AGENT_EXECUTION_EVENT_MAX_PER_EXECUTION",
                    _DEFAULT_EVENT_MAX_PER_EXECUTION)


def prune_execution_events(conn) -> int:
    """Bound the durable event log for TERMINAL executions only.

    Dual cap: an event is kept only if it is within the retention window AND
    among the newest N for that execution. When anything would be removed, the
    oldest dropped row is rewritten into an explicit
    ``execution.events_truncated`` marker (same ``seq``, so replay from
    ``after=0`` still sees the cut) and the rest of the truncated set is
    deleted. Active (queued/running) and waiting executions are never touched
    — their live cursor must remain complete.

    Returns the number of event rows actually deleted (the rewritten marker
    is not counted as a deletion). ``0`` on either cap disables that cap;
    both ``0`` disables the pass.
    """
    days = _event_retention_days()
    max_per = _event_max_per_execution()
    if days <= 0 and max_per <= 0:
        return 0
    cutoff = None
    if days > 0:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
    terminal = conn.execute(
        "SELECT id FROM task_executions WHERE status IN (?, ?, ?, ?)",
        store.EXEC_TERMINAL_STATUSES,
    ).fetchall()
    deleted = 0
    for row in terminal:
        exec_id = row["id"]
        events = conn.execute(
            "SELECT seq, created_at FROM execution_events "
            "WHERE execution_id = ? ORDER BY seq",
            (exec_id,),
        ).fetchall()
        if not events:
            continue
        newest = {r["seq"] for r in events[-max_per:]} if max_per > 0 else None
        drop_seqs: list[int] = []
        for ev in events:
            keep_age = days <= 0 or (ev["created_at"] or "") >= (cutoff or "")
            keep_count = newest is None or ev["seq"] in newest
            if not (keep_age and keep_count):
                drop_seqs.append(ev["seq"])
        if not drop_seqs:
            continue
        marker_seq = drop_seqs[0]
        drop_set = set(drop_seqs)
        kept = [ev["seq"] for ev in events if ev["seq"] not in drop_set]
        payload = store._dumps({
            "truncated": True,
            "removed_count": len(drop_seqs),
            "oldest_remaining_seq": kept[0] if kept else None,
            "retention_days": days if days > 0 else None,
            "max_per_execution": max_per if max_per > 0 else None,
            "note": (f"{len(drop_seqs)} earlier event(s) were removed by startup "
                     "retention. This marker is the explicit record of that cut "
                     "— it is not silent."),
        })
        conn.execute(
            "UPDATE execution_events SET event_type = ?, payload_json_sanitized = ? "
            "WHERE execution_id = ? AND seq = ?",
            (_EVENT_TRUNCATED_TYPE, payload, exec_id, marker_seq),
        )
        rest = [s for s in drop_seqs if s != marker_seq]
        if rest:
            ph = ",".join("?" * len(rest))
            cur = conn.execute(
                f"DELETE FROM execution_events WHERE execution_id = ? AND seq IN ({ph})",
                (exec_id, *rest),
            )
            deleted += max(0, int(cur.rowcount or 0))
    conn.commit()
    return deleted


def run_startup_maintenance() -> dict[str, int]:
    """Run all maintenance passes. Best-effort; never raises into startup."""
    conn = connect()
    try:
        result = {
            "orphan_agent_runs_removed": sweep_orphaned_agent_runs(conn),
            "audit_rows_pruned": prune_audit_logs(conn),
            "execution_events_pruned": prune_execution_events(conn),
        }
        return result
    except Exception:  # noqa: BLE001 - maintenance must never block startup
        return {"orphan_agent_runs_removed": 0, "audit_rows_pruned": 0,
                "execution_events_pruned": 0}
    finally:
        conn.close()
