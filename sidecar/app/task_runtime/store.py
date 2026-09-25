"""Durable repositories for the Agent Task runtime.

Everything the runtime knows lives here as plain rows: the task's lifecycle, the
executions it ran, the structured events those executions emitted, the durable
Work Results, first-class Decisions, the Artifact index, and the versioned
Storage Task Context. Take the UI away and these tables ARE the product state.

Sanitization: every free-text/JSON value is redaction-passed on write (rule 14
holds at the persistence boundary on its own), and payloads are bounded — the
event log is structured progress, never raw tool payloads or chain-of-thought.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from ..repositories import utcnow
from ..security.redaction import redact, redact_text

# --- lifecycle vocabulary -----------------------------------------------------

# Task lifecycle (durable; projected straight into the product task states).
TASK_READY = "ready"
TASK_WORKING = "working"
TASK_NEEDS_DECISION = "needs_decision"  # legacy (pre-2.1); never derived now
TASK_NEEDS_ATTENTION = "needs_attention"
TASK_ARCHIVED = "archived"

# Execution lifecycle. `waiting` is legacy (pre-2.1 approvals paused an
# execution on a Decision); nothing sets it now and recovery stamps any left
# over `interrupted`. `interrupted` is stamped by restart recovery on
# executions a dead process left in flight.
EXEC_QUEUED = "queued"
EXEC_RUNNING = "running"
EXEC_WAITING = "waiting"
EXEC_COMPLETED = "completed"
EXEC_FAILED = "failed"
EXEC_CANCELLED = "cancelled"
EXEC_INTERRUPTED = "interrupted"

EXEC_ACTIVE_STATUSES = (EXEC_QUEUED, EXEC_RUNNING)
EXEC_TERMINAL_STATUSES = (EXEC_COMPLETED, EXEC_FAILED, EXEC_CANCELLED, EXEC_INTERRUPTED)

# Decision lifecycle.
DECISION_PENDING = "pending"
DECISION_APPROVED = "approved"
DECISION_DECLINED = "declined"
DECISION_SUPERSEDED = "superseded"

# Decision kinds — history only since v2.1 (the product no longer raises or
# resolves Decisions; the rows stay readable). `approval` rows were raised by
# a gated tool (v1.11–v2.0); `proposal` rows are pre-1.11.
DECISION_KIND_APPROVAL = "approval"
DECISION_KIND_PROPOSAL = "proposal"

# Bound on one persisted event payload. Structured progress records are small by
# construction; this is the backstop that keeps the durable log from ever
# carrying a raw payload.
_MAX_EVENT_PAYLOAD = 4000
_MAX_DIRECTION = 16000
_MAX_STEER = 4000


def _new_id() -> str:
    return uuid.uuid4().hex


def _dumps(value: Any) -> str:
    return json.dumps(redact(value), default=str, ensure_ascii=False)


def _loads(raw: Any, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


# --- agent_tasks ----------------------------------------------------------------


def ensure_task(conn: sqlite3.Connection, task_id: str, title: str = "",
                goal: str | None = None) -> None:
    """Make sure the durable task row exists (idempotent).

    Sessions created before migration 026 are backfilled by the migration; this
    covers rows created by direct SQL in tests or by an older process version
    racing the upgrade.
    """
    now = utcnow()
    conn.execute(
        "INSERT INTO agent_tasks (id, title, goal, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        (task_id, redact_text(title or "Untitled task"), redact_text(goal or "") or None,
         TASK_READY, now, now),
    )


def get_task(conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM agent_tasks WHERE id = ?", (task_id,)).fetchone()
    return dict(row) if row else None


def set_task_status(conn: sqlite3.Connection, task_id: str, status: str,
                    active_execution_id: str | None = None,
                    clear_active: bool = False) -> None:
    if clear_active:
        conn.execute(
            "UPDATE agent_tasks SET status = ?, active_execution_id = NULL, updated_at = ? "
            "WHERE id = ?", (status, utcnow(), task_id))
    elif active_execution_id is not None:
        conn.execute(
            "UPDATE agent_tasks SET status = ?, active_execution_id = ?, updated_at = ? "
            "WHERE id = ?", (status, active_execution_id, utcnow(), task_id))
    else:
        conn.execute(
            "UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?",
            (status, utcnow(), task_id))


def sync_task_identity(conn: sqlite3.Connection, task_id: str,
                       title: str | None = None, goal: str | None = None,
                       archived: bool | None = None) -> None:
    """Keep the task row's seeded identity columns in step with the session
    compatibility row (title/goal edits, archive state)."""
    sets, params = [], []
    if title is not None:
        sets.append("title = ?")
        params.append(redact_text(title))
    if goal is not None:
        sets.append("goal = ?")
        params.append(redact_text(goal) or None)
    if archived is True:
        sets.append("status = ?")
        params.append(TASK_ARCHIVED)
    if not sets:
        return
    sets.append("updated_at = ?")
    params.append(utcnow())
    params.append(task_id)
    conn.execute(f"UPDATE agent_tasks SET {', '.join(sets)} WHERE id = ?", params)


def derive_task_status(conn: sqlite3.Connection, task_id: str) -> str:
    """The task's CURRENT status derived from durable runtime state.

    Working (an execution queued/running) outranks everything; an interrupted
    or failed most-recent execution is Needs attention; otherwise Ready. (v2.1:
    nothing pauses for a Decision any more, so there is no "needs decision".) This is the single derivation both the setter and the
    recovery path use, so the stored column can never drift from the rows."""
    active = conn.execute(
        "SELECT 1 FROM task_executions WHERE task_id = ? AND status IN (?, ?) LIMIT 1",
        (task_id, EXEC_QUEUED, EXEC_RUNNING)).fetchone()
    if active:
        return TASK_WORKING
    last = conn.execute(
        "SELECT status FROM task_executions WHERE task_id = ? "
        "ORDER BY rowid DESC LIMIT 1", (task_id,)).fetchone()
    if last and last["status"] in (EXEC_FAILED, EXEC_INTERRUPTED):
        return TASK_NEEDS_ATTENTION
    return TASK_READY


def refresh_task_status(conn: sqlite3.Connection, task_id: str) -> str:
    status = derive_task_status(conn, task_id)
    row = get_task(conn, task_id)
    # Archived is a user choice, not a derived state — never overwrite it here.
    if row and row.get("status") == TASK_ARCHIVED:
        return TASK_ARCHIVED
    set_task_status(conn, task_id, status,
                    clear_active=(status != TASK_WORKING))
    _append_task_status_event(conn, task_id, status)
    return status


_MAX_STATUS_QUEUE = 10


def task_status_payload(conn: sqlite3.Connection, task_id: str,
                        status: str | None = None) -> dict[str, Any]:
    """What a client needs to know about the task beside the execution it is
    following (v1.12): derived status, the live execution, queued Directions,
    and the latest execution's terminal state. Bounded — never a whole task."""
    live = active_execution(conn, task_id)
    queued = conn.execute(
        "SELECT id, direction, kind, created_at FROM task_executions "
        "WHERE task_id = ? AND status = ? ORDER BY rowid ASC LIMIT ?",
        (task_id, EXEC_QUEUED, _MAX_STATUS_QUEUE)).fetchall()
    last = conn.execute(
        "SELECT id, status FROM task_executions WHERE task_id = ? "
        "ORDER BY rowid DESC LIMIT 1", (task_id,)).fetchone()
    return {
        "status": status or derive_task_status(conn, task_id),
        "active_execution_id": live["id"] if live else None,
        "queued": [{"id": q["id"], "direction": (q["direction"] or "")[:200],
                    "kind": q["kind"], "created_at": q["created_at"]} for q in queued],
        "last_execution": {"id": last["id"], "status": last["status"]} if last else None,
    }


def _status_target_execution(conn: sqlite3.Connection, task_id: str) -> str | None:
    """The execution log a `task.status` event belongs to: the one a follower
    would be attached to — running, else waiting, else the newest row."""
    row = conn.execute(
        "SELECT id FROM task_executions WHERE task_id = ? AND status IN (?, ?) "
        "ORDER BY rowid ASC LIMIT 1", (task_id, EXEC_RUNNING, EXEC_WAITING)).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT id FROM task_executions WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
            (task_id,)).fetchone()
    return row["id"] if row else None


def _append_task_status_event(conn: sqlite3.Connection, task_id: str, status: str) -> None:
    target = _status_target_execution(conn, task_id)
    if target is None:
        return
    append_event(conn, target, task_id, "task.status",
                 task_status_payload(conn, task_id, status), commit=False)


def note_task_status(conn: sqlite3.Connection, task_id: str) -> None:
    """Announce the task's current status/queue/pending set on the execution
    log a follower is attached to (no status change required)."""
    _append_task_status_event(conn, task_id, derive_task_status(conn, task_id))


# --- task_executions ------------------------------------------------------------


def create_execution(conn: sqlite3.Connection, task_id: str, direction: str,
                     turn_id: str | None = None, kind: str = "direction",
                     resumed_from: str | None = None) -> dict[str, Any]:
    """Insert a queued execution. Raises sqlite3.IntegrityError on a duplicate
    (task_id, turn_id) — the caller treats that as attach-don't-rerun."""
    now = utcnow()
    exec_id = _new_id()
    conn.execute(
        "INSERT INTO task_executions "
        "(id, task_id, turn_id, direction, kind, status, resumed_from, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (exec_id, task_id, turn_id, redact_text(direction or "")[:_MAX_DIRECTION],
         kind, EXEC_QUEUED, resumed_from, now, now),
    )
    return get_execution(conn, exec_id)  # type: ignore[return-value]


def get_execution(conn: sqlite3.Connection, execution_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM task_executions WHERE id = ?", (execution_id,)).fetchone()
    return dict(row) if row else None


def get_execution_by_turn(conn: sqlite3.Connection, task_id: str,
                          turn_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM task_executions WHERE task_id = ? AND turn_id = ?",
        (task_id, turn_id)).fetchone()
    return dict(row) if row else None


def list_executions(conn: sqlite3.Connection, task_id: str,
                    limit: int = 50) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM task_executions WHERE task_id = ? "
        "ORDER BY rowid DESC LIMIT ?", (task_id, max(1, int(limit)))).fetchall()
    return [dict(r) for r in reversed(rows)]


def active_execution(conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
    """The task's queued or running execution, if any (at most one runs; queued
    ones wait behind it in creation order — this returns the OLDEST active)."""
    row = conn.execute(
        "SELECT * FROM task_executions WHERE task_id = ? AND status IN (?, ?) "
        "ORDER BY rowid ASC LIMIT 1", (task_id, EXEC_RUNNING, EXEC_QUEUED)).fetchone()
    return dict(row) if row else None


def next_queued_execution(conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM task_executions WHERE task_id = ? AND status = ? "
        "ORDER BY rowid ASC LIMIT 1", (task_id, EXEC_QUEUED)).fetchone()
    return dict(row) if row else None


def set_execution_status(conn: sqlite3.Connection, execution_id: str, status: str,
                         error: str | None = None,
                         work_result_id: str | None = None) -> None:
    now = utcnow()
    sets = ["status = ?", "updated_at = ?"]
    params: list[Any] = [status, now]
    if status == EXEC_RUNNING:
        sets.append("started_at = COALESCE(started_at, ?)")
        params.append(now)
    if status in EXEC_TERMINAL_STATUSES or status == EXEC_WAITING:
        sets.append("finished_at = COALESCE(finished_at, ?)")
        params.append(now)
    if error is not None:
        sets.append("error = ?")
        params.append(redact_text(error)[:2000])
    if work_result_id is not None:
        sets.append("work_result_id = ?")
        params.append(work_result_id)
    params.append(execution_id)
    conn.execute(f"UPDATE task_executions SET {', '.join(sets)} WHERE id = ?", params)


def update_queued_direction(conn: sqlite3.Connection, execution_id: str,
                            direction: str) -> dict[str, Any] | None:
    """Replace a QUEUED execution's direction (v1.14 — queued work is
    editable, not just cancellable). Returns the updated row, or None when
    the execution is unknown or no longer queued."""
    cur = conn.execute(
        "UPDATE task_executions SET direction = ?, updated_at = ? "
        "WHERE id = ? AND status = ?",
        (redact_text(direction or "")[:_MAX_DIRECTION], utcnow(),
         execution_id, EXEC_QUEUED))
    if cur.rowcount <= 0:
        return None
    row = conn.execute("SELECT * FROM task_executions WHERE id = ?",
                       (execution_id,)).fetchone()
    return dict(row) if row else None


def bump_steer_count(conn: sqlite3.Connection, execution_id: str) -> None:
    conn.execute(
        "UPDATE task_executions SET steer_count = steer_count + 1, updated_at = ? "
        "WHERE id = ?", (utcnow(), execution_id))


# --- execution_events -------------------------------------------------------------


def append_event(conn: sqlite3.Connection, execution_id: str, task_id: str,
                 event_type: str, payload: dict[str, Any] | None = None,
                 commit: bool = True) -> int:
    """Append one structured durable event; returns its seq.

    Payloads are sanitized and BOUNDED — a payload that serializes past the cap
    is replaced by a marker rather than truncated into invalid JSON."""
    raw = _dumps(payload or {})
    if len(raw) > _MAX_EVENT_PAYLOAD:
        raw = _dumps({"truncated": True,
                      "note": f"payload of {len(raw)} chars withheld from the event log"})
    cur = conn.execute(
        "INSERT INTO execution_events (execution_id, task_id, event_type, "
        "payload_json_sanitized, created_at) VALUES (?, ?, ?, ?, ?)",
        (execution_id, task_id, event_type, raw, utcnow()),
    )
    if commit:
        conn.commit()
    seq = int(cur.lastrowid or 0)
    # Wake any live subscriber promptly (best-effort; polling is the fallback).
    from . import hub
    hub.notify(execution_id, seq)
    return seq


def list_events(conn: sqlite3.Connection, execution_id: str, after_seq: int = 0,
                limit: int = 1000, up_to_seq: int | None = None) -> list[dict[str, Any]]:
    if up_to_seq is not None:
        rows = conn.execute(
            "SELECT seq, execution_id, task_id, event_type, payload_json_sanitized, created_at "
            "FROM execution_events WHERE execution_id = ? AND seq > ? AND seq <= ? "
            "ORDER BY seq LIMIT ?",
            (execution_id, int(after_seq), int(up_to_seq), max(1, int(limit)))).fetchall()
    else:
        rows = conn.execute(
            "SELECT seq, execution_id, task_id, event_type, payload_json_sanitized, created_at "
            "FROM execution_events WHERE execution_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            (execution_id, int(after_seq), max(1, int(limit)))).fetchall()
    return [{
        "seq": r["seq"], "execution_id": r["execution_id"], "task_id": r["task_id"],
        "event_type": r["event_type"],
        "payload": _loads(r["payload_json_sanitized"], {}),
        "created_at": r["created_at"],
    } for r in rows]


def unannounced_compaction(conn: sqlite3.Connection, task_id: str,
                           exclude_execution_id: str) -> dict[str, Any] | None:
    """v1.12 — the payload of an ON-DEMAND compaction (`context.compacted` with
    an empty execution_id) that no execution has carried yet: nothing but this
    new execution's own frames landed after it. The next execution re-emits it
    on its stream so the transcript shows the marker where the turn starts."""
    row = conn.execute(
        "SELECT seq, payload_json_sanitized FROM execution_events WHERE task_id = ? "
        "AND event_type = 'context.compacted' AND execution_id = '' "
        "ORDER BY seq DESC LIMIT 1", (task_id,)).fetchone()
    if row is None:
        return None
    later = conn.execute(
        "SELECT 1 FROM execution_events WHERE task_id = ? AND seq > ? "
        "AND execution_id != '' AND execution_id != ? LIMIT 1",
        (task_id, int(row["seq"]), exclude_execution_id)).fetchone()
    if later is not None:
        return None
    return _loads(row["payload_json_sanitized"], {})


def list_task_events(conn: sqlite3.Connection, task_id: str, after_seq: int = 0,
                     limit: int = 1000) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT seq, execution_id, task_id, event_type, payload_json_sanitized, created_at "
        "FROM execution_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        (task_id, int(after_seq), max(1, int(limit)))).fetchall()
    return [{
        "seq": r["seq"], "execution_id": r["execution_id"], "task_id": r["task_id"],
        "event_type": r["event_type"],
        "payload": _loads(r["payload_json_sanitized"], {}),
        "created_at": r["created_at"],
    } for r in rows]


# --- work_results ----------------------------------------------------------------


def record_work_result(conn: sqlite3.Connection, task_id: str, execution_id: str | None,
                       message_id: str | None, *, kind: str = "answer",
                       stopped: bool = False, cut_short: str | None = None,
                       grounding: dict[str, Any] | None = None,
                       proposals: list[dict[str, Any]] | None = None,
                       conclusion: dict[str, Any] | None = None) -> str:
    wr_id = _new_id()
    conn.execute(
        "INSERT INTO work_results (id, task_id, execution_id, message_id, kind, stopped, "
        "cut_short, grounding_json_sanitized, proposals_json_sanitized, "
        "conclusion_json_sanitized, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (wr_id, task_id, execution_id, message_id, kind, 1 if stopped else 0,
         cut_short, _dumps(grounding or {}), _dumps(proposals or []),
         _dumps(conclusion) if conclusion else None, utcnow()),
    )
    return wr_id


def list_work_results(conn: sqlite3.Connection, task_id: str,
                      limit: int = 100) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM work_results WHERE task_id = ? ORDER BY rowid DESC LIMIT ?",
        (task_id, max(1, int(limit)))).fetchall()
    return [_work_result_dict(r) for r in reversed(rows)]


def get_work_result(conn: sqlite3.Connection, wr_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM work_results WHERE id = ?", (wr_id,)).fetchone()
    return _work_result_dict(row) if row else None


def _work_result_dict(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"], "task_id": r["task_id"], "execution_id": r["execution_id"],
        "message_id": r["message_id"], "kind": r["kind"], "stopped": bool(r["stopped"]),
        "cut_short": r["cut_short"],
        "grounding": _loads(r["grounding_json_sanitized"], {}),
        "proposals": _loads(r["proposals_json_sanitized"], []),
        "conclusion": (_loads(r["conclusion_json_sanitized"], None)
                       if "conclusion_json_sanitized" in r.keys() else None),
        "created_at": r["created_at"],
    }


# --- task_decisions ----------------------------------------------------------------


def get_decision(conn: sqlite3.Connection, decision_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM task_decisions WHERE id = ?", (decision_id,)).fetchone()
    return _decision_dict(row) if row else None


def list_decisions(conn: sqlite3.Connection, task_id: str,
                   status: str | None = None) -> list[dict[str, Any]]:
    if status:
        rows = conn.execute(
            "SELECT * FROM task_decisions WHERE task_id = ? AND status = ? ORDER BY rowid",
            (task_id, status)).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM task_decisions WHERE task_id = ? ORDER BY rowid",
            (task_id,)).fetchall()
    return [_decision_dict(r) for r in rows]


def _decision_dict(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"], "task_id": r["task_id"], "execution_id": r["execution_id"],
        "work_result_id": r["work_result_id"], "action_type": r["action_type"],
        "title": r["title"], "reason": r["reason"],
        "proposal": _loads(r["proposal_json_sanitized"], {}),
        "status": r["status"], "resolution_note": r["resolution_note"],
        "kind": (r["kind"] if "kind" in r.keys() else None) or DECISION_KIND_PROPOSAL,
        "scope": r["scope"] if "scope" in r.keys() else None,
        "created_at": r["created_at"], "resolved_at": r["resolved_at"],
    }


# --- task_artifacts ----------------------------------------------------------------


def record_artifact(conn: sqlite3.Connection, task_id: str, artifact_type: str,
                    *, execution_id: str | None = None, title: str | None = None,
                    ref_kind: str | None = None, ref_id: str | None = None,
                    format: str | None = None, summary: str | None = None,
                    status: str | None = None, payload: Any = None) -> str:
    """Index one durable artifact for a task. Dedupe on (task, type, ref) so a
    re-render of the same report or a re-read of the same import doesn't stack
    duplicate rows — the artifact is the durable thing, not the click."""
    if ref_id:
        existing = conn.execute(
            "SELECT id FROM task_artifacts WHERE task_id = ? AND artifact_type = ? "
            "AND ref_kind IS ? AND ref_id = ? LIMIT 1",
            (task_id, artifact_type, ref_kind, ref_id)).fetchone()
        if existing:
            if status is not None or payload is not None:
                conn.execute(
                    "UPDATE task_artifacts SET status = COALESCE(?, status), "
                    "payload_json_sanitized = COALESCE(?, payload_json_sanitized), "
                    "summary = COALESCE(?, summary) WHERE id = ?",
                    (status, _dumps(payload) if payload is not None else None,
                     redact_text(str(summary or ""))[:400] or None, existing["id"]),
                )
            return existing["id"]
    art_id = _new_id()
    conn.execute(
        "INSERT INTO task_artifacts (id, task_id, execution_id, artifact_type, title, "
        "ref_kind, ref_id, format, summary, created_at, status, payload_json_sanitized) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (art_id, task_id, execution_id, artifact_type,
         redact_text(str(title or ""))[:200] or None, ref_kind, ref_id, format,
         redact_text(str(summary or ""))[:400] or None, utcnow(),
         status, _dumps(payload) if payload is not None else None),
    )
    return art_id


def list_artifacts(conn: sqlite3.Connection, task_id: str,
                   limit: int = 200) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY rowid DESC LIMIT ?",
        (task_id, max(1, int(limit)))).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        item = dict(r)
        if item.get("payload_json_sanitized"):
            item["payload"] = _loads(item["payload_json_sanitized"], None)
        out.append(item)
    return out


# --- task_context_versions -----------------------------------------------------------


def latest_context(conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM task_context_versions WHERE task_id = ? "
        "ORDER BY version DESC LIMIT 1", (task_id,)).fetchone()
    if row is None:
        return None
    keys = row.keys()
    return {
        "task_id": row["task_id"], "version": row["version"],
        "context": _loads(row["context_json_sanitized"], {}),
        "updated_by_execution_id": row["updated_by_execution_id"],
        "created_at": row["created_at"],
        # v1.12 — compaction summary (carried forward across versions).
        "summary": row["summary_sanitized"] if "summary_sanitized" in keys else None,
        "summary_through_seq": (int(row["summary_through_seq"])
                                if "summary_through_seq" in keys
                                and row["summary_through_seq"] is not None else None),
    }


def save_context_version(conn: sqlite3.Connection, task_id: str,
                         context_doc: dict[str, Any],
                         execution_id: str | None = None) -> int | None:
    """Persist a new context version IF it differs from the latest. Returns the
    new version number, or None when unchanged (no version churn)."""
    raw = _dumps(context_doc)
    latest = conn.execute(
        "SELECT version, context_json_sanitized, summary_sanitized, summary_through_seq "
        "FROM task_context_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1",
        (task_id,)).fetchone()
    if latest is not None and latest["context_json_sanitized"] == raw:
        return None
    return _insert_context_version(
        conn, task_id, latest, raw, execution_id,
        summary=latest["summary_sanitized"] if latest is not None else None,
        through_seq=latest["summary_through_seq"] if latest is not None else None)


def save_context_summary(conn: sqlite3.Connection, task_id: str,
                         context_doc: dict[str, Any], summary: str,
                         through_seq: int | None,
                         execution_id: str | None = None) -> int:
    """v1.12 — persist a compaction summary as a NEW context version (even when
    the typed document itself is unchanged): the summary is part of the
    grounding the next execution starts from, so it is versioned with it."""
    raw = _dumps(context_doc)
    latest = conn.execute(
        "SELECT version FROM task_context_versions WHERE task_id = ? "
        "ORDER BY version DESC LIMIT 1", (task_id,)).fetchone()
    return _insert_context_version(conn, task_id, latest, raw, execution_id,
                                   summary=redact_text(str(summary))[:4000],
                                   through_seq=through_seq)


def _insert_context_version(conn: sqlite3.Connection, task_id: str, latest: Any,
                            raw: str, execution_id: str | None, *,
                            summary: str | None, through_seq: int | None) -> int:
    version = (int(latest["version"]) if latest is not None else 0) + 1
    conn.execute(
        "INSERT INTO task_context_versions (task_id, version, context_json_sanitized, "
        "updated_by_execution_id, created_at, summary_sanitized, summary_through_seq) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (task_id, version, raw, execution_id, utcnow(), summary,
         int(through_seq) if through_seq is not None else None),
    )
    conn.execute(
        "UPDATE agent_tasks SET context_version = ?, updated_at = ? WHERE id = ?",
        (version, utcnow(), task_id))
    return version
