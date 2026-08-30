"""Startup and periodic data maintenance — bounded reclamation.

The app writes local artifacts (per-run directories) and append-only rows
(``audit_logs``, ad-hoc ``tool_calls``, ``execution_events``) that otherwise
grow without bound over months of daily use. This runs at startup and again on
a low-frequency loop while the Sidecar is up. It is deliberately conservative:

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
  The prune is a SQL set delete (no per-event Python materialization).

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

    Implemented as SQL set operations so a large log cannot peak as a Python
    list of every seq. Returns the number of event rows actually deleted (the
    rewritten marker is not counted as a deletion). ``0`` on either cap
    disables that cap; both ``0`` disables the pass.
    """
    days = _event_retention_days()
    max_per = _event_max_per_execution()
    if days <= 0 and max_per <= 0:
        return 0
    cutoff = "0000-01-01T00:00:00Z"
    if days > 0:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
    conn.execute("DROP TABLE IF EXISTS _ee_drop")
    conn.execute("DROP TABLE IF EXISTS _ee_mark")
    conn.execute(
        "CREATE TEMP TABLE _ee_drop ("
        "execution_id TEXT NOT NULL, seq INTEGER NOT NULL, "
        "PRIMARY KEY (execution_id, seq))"
    )
    conn.execute(
        "INSERT INTO _ee_drop (execution_id, seq) "
        "SELECT execution_id, seq FROM ("
        "  SELECT e.execution_id, e.seq, e.created_at, "
        "         ROW_NUMBER() OVER (PARTITION BY e.execution_id ORDER BY e.seq DESC) AS recency "
        "  FROM execution_events e "
        "  JOIN task_executions x ON x.id = e.execution_id "
        "  WHERE x.status IN (?, ?, ?, ?)"
        ") ranked "
        "WHERE ((? > 0) AND recency > ?) OR ((? > 0) AND created_at < ?)",
        (*store.EXEC_TERMINAL_STATUSES, max_per, max_per, days, cutoff),
    )
    conn.execute(
        "CREATE TEMP TABLE _ee_mark AS "
        "SELECT execution_id, MIN(seq) AS marker_seq, COUNT(*) AS removed_count "
        "FROM _ee_drop GROUP BY execution_id"
    )
    conn.execute(
        "UPDATE execution_events SET event_type = ?, payload_json_sanitized = ("
        "  SELECT json_object("
        "    'truncated', 1,"
        "    'removed_count', m.removed_count,"
        "    'oldest_remaining_seq', ("
        "      SELECT MIN(e2.seq) FROM execution_events e2"
        "      WHERE e2.execution_id = m.execution_id"
        "        AND e2.seq NOT IN ("
        "          SELECT d.seq FROM _ee_drop d"
        "          WHERE d.execution_id = m.execution_id AND d.seq != m.marker_seq"
        "        )"
        "    ),"
        "    'retention_days', CASE WHEN ? > 0 THEN ? ELSE NULL END,"
        "    'max_per_execution', CASE WHEN ? > 0 THEN ? ELSE NULL END,"
        "    'note', m.removed_count || ' earlier event(s) were removed by "
        "retention. This marker is the explicit record of that cut — it is not silent.'"
        "  ) FROM _ee_mark m"
        "  WHERE m.execution_id = execution_events.execution_id"
        "    AND m.marker_seq = execution_events.seq"
        ") WHERE rowid IN ("
        "  SELECT e.rowid FROM execution_events e"
        "  JOIN _ee_mark m ON m.execution_id = e.execution_id AND m.marker_seq = e.seq"
        ")",
        (_EVENT_TRUNCATED_TYPE, days, days, max_per, max_per),
    )
    cur = conn.execute(
        "DELETE FROM execution_events WHERE rowid IN ("
        "  SELECT e.rowid FROM execution_events e"
        "  JOIN _ee_drop d ON d.execution_id = e.execution_id AND d.seq = e.seq"
        "  JOIN _ee_mark m ON m.execution_id = d.execution_id"
        "  WHERE d.seq != m.marker_seq"
        ")"
    )
    deleted = max(0, int(cur.rowcount or 0))
    conn.execute("DROP TABLE IF EXISTS _ee_drop")
    conn.execute("DROP TABLE IF EXISTS _ee_mark")
    conn.commit()
    return deleted


def run_periodic_maintenance() -> dict[str, int]:
    """Same bounded passes as startup, plus due Task revisits.

    Safe to call from a low-frequency loop. Never raises. Revisit submit uses
    the existing runtime ``submit()`` path (kind=revisit) — not a second runner.
    """
    result = run_startup_maintenance()
    try:
        from .task_runtime import revisit as revisit_sched
        result["revisits_submitted"] = revisit_sched.tick()
    except Exception:  # noqa: BLE001
        result["revisits_submitted"] = 0
    return result


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
