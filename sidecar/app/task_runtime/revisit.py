"""Per-task scheduled revisit — read-only, via the existing submit path.

Desktop has no background daemon: this runs at Sidecar startup and on the
low-frequency maintenance loop. Missed due times are submitted as catch-up
and labelled as such. Confirmation-gated work is never auto-approved.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import sqlite3

from ..agent_runtime.agent_service import AgentUnavailable
from ..repositories import utcnow
from . import runtime, store

logger = logging.getLogger(__name__)

_MIN_DAYS = 1
_MAX_DAYS = 365

REVISIT_KIND = "revisit"
VERIFY_KIND = "verify"

_REVISIT_DIRECTION = (
    "[revisit] Scheduled read-only re-check of this Task. Capture a baseline "
    "if none exists, otherwise produce a Drift report against the latest "
    "baseline. Use only read-only tools. If a confirmation-gated action is "
    "needed, open a pending Decision and wait — never apply storage changes "
    "and never resolve a Decision yourself."
)
_CATCHUP_PREFIX = (
    "[revisit][catch-up] The app was closed past the due time; this is a "
    "catch-up visit. "
)


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.strptime(ts.replace("Z", ""), "%Y-%m-%dT%H:%M:%S").replace(
            tzinfo=timezone.utc)
    except ValueError:
        return None


def get_schedule(conn: sqlite3.Connection, task_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM task_revisit_schedules WHERE task_id = ?", (task_id,),
    ).fetchone()
    if row is None:
        return None
    return dict(row)


def set_schedule(conn: sqlite3.Connection, task_id: str, *,
                 interval_days: int, enabled: bool = True) -> dict:
    store.ensure_task(conn, task_id)
    days = max(_MIN_DAYS, min(_MAX_DAYS, int(interval_days)))
    now = datetime.now(timezone.utc)
    next_due = (now + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stamp = utcnow()
    existing = get_schedule(conn, task_id)
    if existing is None:
        conn.execute(
            "INSERT INTO task_revisit_schedules (task_id, enabled, interval_days, "
            "next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (task_id, 1 if enabled else 0, days, next_due if enabled else None,
             stamp, stamp),
        )
    else:
        conn.execute(
            "UPDATE task_revisit_schedules SET enabled = ?, interval_days = ?, "
            "next_due_at = ?, last_catchup_note = CASE WHEN ? = 0 THEN NULL "
            "ELSE last_catchup_note END, updated_at = ? WHERE task_id = ?",
            (1 if enabled else 0, days, next_due if enabled else None,
             1 if enabled else 0, stamp, task_id),
        )
    conn.commit()
    return get_schedule(conn, task_id)  # type: ignore[return-value]


def due_rows(conn: sqlite3.Connection, *, now: str | None = None) -> list[dict]:
    stamp = now or utcnow()
    rows = conn.execute(
        "SELECT * FROM task_revisit_schedules WHERE enabled = 1 "
        "AND next_due_at IS NOT NULL AND next_due_at <= ?",
        (stamp,),
    ).fetchall()
    return [dict(r) for r in rows]


def _already_inflight(conn: sqlite3.Connection, task_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM task_executions WHERE task_id = ? AND kind = ? "
        "AND status IN (?, ?) LIMIT 1",
        (task_id, REVISIT_KIND, store.EXEC_QUEUED, store.EXEC_RUNNING),
    ).fetchone()
    return row is not None


def tick(now: str | None = None, conn: sqlite3.Connection | None = None) -> int:
    """Submit one revisit Execution per due schedule via ``runtime.submit``.

    Never resolves Decisions. Catch-up visits are labelled in the Direction.
    Returns the number of executions submitted.

    When ``conn`` is omitted the function opens and closes its own connection
    (startup / periodic maintenance). Callers that already hold a request
    connection should pass it so catch-up uses the same database.
    """
    from ..db import connect
    own = conn is None
    if own:
        conn = connect()
    submitted = 0
    stamp = now or utcnow()
    try:
        for row in due_rows(conn, now=stamp):
            task_id = row["task_id"]
            if store.get_task(conn, task_id) is None:
                continue
            if _already_inflight(conn, task_id):
                continue
            due_at = _parse(row.get("next_due_at"))
            now_dt = _parse(stamp) or datetime.now(timezone.utc)
            catchup = bool(due_at and now_dt - due_at > timedelta(hours=1))
            direction = (_CATCHUP_PREFIX + _REVISIT_DIRECTION) if catchup else _REVISIT_DIRECTION
            days = max(_MIN_DAYS, int(row["interval_days"] or 7))
            next_due = (now_dt + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
            note = "catch-up" if catchup else None
            # Claim the due row BEFORE submit so two app-open list requests
            # cannot enqueue two revisits for the same schedule.
            claimed = conn.execute(
                "UPDATE task_revisit_schedules SET last_revisit_at = ?, next_due_at = ?, "
                "last_catchup_note = ?, updated_at = ? WHERE task_id = ? AND enabled = 1 "
                "AND next_due_at IS NOT NULL AND next_due_at = ?",
                (stamp, next_due, note, stamp, task_id, row["next_due_at"]),
            )
            conn.commit()
            if claimed.rowcount <= 0:
                continue
            try:
                runtime.submit(conn, task_id, direction, kind=REVISIT_KIND)
            except (AgentUnavailable, KeyError) as exc:
                logger.info("revisit skipped for %s: %s", task_id, exc)
                conn.execute(
                    "UPDATE task_revisit_schedules SET next_due_at = ?, last_revisit_at = NULL, "
                    "last_catchup_note = NULL, updated_at = ? WHERE task_id = ?",
                    (row["next_due_at"], stamp, task_id),
                )
                conn.commit()
                continue
            submitted += 1
        return submitted
    finally:
        if own:
            conn.close()
