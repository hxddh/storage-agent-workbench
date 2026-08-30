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
TASK_NEEDS_DECISION = "needs_decision"
TASK_NEEDS_ATTENTION = "needs_attention"
TASK_ARCHIVED = "archived"

# Execution lifecycle. `waiting` means the execution's model work is done but a
# confirmation-gated Decision it raised is still pending — the delegated work is
# not finished until the user crosses that boundary. `interrupted` is stamped by
# restart recovery on executions a dead process left queued/running.
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

# Proposal action types that raise a first-class blocking Decision. Everything
# else stays a suggestion on the Work Result (the agent can be asked to do it
# conversationally). The data-moving imports MUST stay here — they gate cloud
# downloads behind explicit confirmation; the saved report gates a durable
# artifact write.
DECISION_GATED_ACTION_TYPES = frozenset({
    "plan_inventory_import", "plan_access_log_import", "generate_session_report",
})

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

    Working (an execution queued/running) outranks a pending Decision; a pending
    Decision outranks Ready; an interrupted or failed most-recent execution is
    Needs attention. This is the single derivation both the setter and the
    recovery path use, so the stored column can never drift from the rows."""
    active = conn.execute(
        "SELECT 1 FROM task_executions WHERE task_id = ? AND status IN (?, ?) LIMIT 1",
        (task_id, EXEC_QUEUED, EXEC_RUNNING)).fetchone()
    if active:
        return TASK_WORKING
    pending = conn.execute(
        "SELECT 1 FROM task_decisions WHERE task_id = ? AND status = ? LIMIT 1",
        (task_id, DECISION_PENDING)).fetchone()
    if pending:
        return TASK_NEEDS_DECISION
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
    return status


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
    hub.notify(execution_id)
    return seq


def list_events(conn: sqlite3.Connection, execution_id: str, after_seq: int = 0,
                limit: int = 1000) -> list[dict[str, Any]]:
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
                       proposals: list[dict[str, Any]] | None = None) -> str:
    wr_id = _new_id()
    conn.execute(
        "INSERT INTO work_results (id, task_id, execution_id, message_id, kind, stopped, "
        "cut_short, grounding_json_sanitized, proposals_json_sanitized, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (wr_id, task_id, execution_id, message_id, kind, 1 if stopped else 0,
         cut_short, _dumps(grounding or {}), _dumps(proposals or []), utcnow()),
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
        "created_at": r["created_at"],
    }


# --- task_decisions ----------------------------------------------------------------


def open_decisions_from_proposals(conn: sqlite3.Connection, task_id: str,
                                  execution_id: str | None, work_result_id: str | None,
                                  proposals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Create pending Decision rows for the confirmation-gated proposals of a new
    Work Result, superseding the task's PRIOR pending decisions (a later Work
    Result outranks older blockers — the same rule the old projection applied,
    now durable instead of re-derived)."""
    gated = [p for p in (proposals or [])
             if isinstance(p, dict)
             and p.get("requires_confirmation") is True
             and p.get("action_type") in DECISION_GATED_ACTION_TYPES]
    # One pending Decision per (task, action_type): later proposal of the same
    # type supersedes the earlier pending row. Also collapse duplicates inside
    # this Work Result (last occurrence wins).
    by_type: dict[str, dict[str, Any]] = {}
    for p in gated:
        by_type[str(p.get("action_type"))[:64]] = p
    gated = list(by_type.values())
    now = utcnow()
    if gated:
        types = list(by_type.keys())
        ph = ",".join("?" * len(types))
        conn.execute(
            f"UPDATE task_decisions SET status = ?, resolved_at = ?, "
            f"resolution_note = COALESCE(resolution_note, 'superseded by a newer work result') "
            f"WHERE task_id = ? AND status = ? AND action_type IN ({ph})",
            (DECISION_SUPERSEDED, now, task_id, DECISION_PENDING, *types))
    else:
        # Empty proposals still retire every pending blocker — a later Work
        # Result that no longer asks for confirmation outranks older ones.
        conn.execute(
            "UPDATE task_decisions SET status = ?, resolved_at = ?, "
            "resolution_note = COALESCE(resolution_note, 'superseded by a newer work result') "
            "WHERE task_id = ? AND status = ?",
            (DECISION_SUPERSEDED, now, task_id, DECISION_PENDING))
    out: list[dict[str, Any]] = []
    for p in gated:
        dec_id = _new_id()
        conn.execute(
            "INSERT INTO task_decisions (id, task_id, execution_id, work_result_id, "
            "action_type, title, reason, proposal_json_sanitized, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (dec_id, task_id, execution_id, work_result_id,
             str(p.get("action_type"))[:64],
             redact_text(str(p.get("title") or ""))[:160] or None,
             redact_text(str(p.get("reason") or ""))[:400] or None,
             _dumps(p), DECISION_PENDING, now),
        )
        out.append(get_decision(conn, dec_id))  # type: ignore[arg-type]
    return out


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


def pending_decision_tasks(conn: sqlite3.Connection,
                           task_ids: list[str]) -> dict[str, bool]:
    """Which of these tasks currently has a pending durable Decision (batched)."""
    if not task_ids:
        return {}
    ph = ",".join("?" * len(task_ids))
    rows = conn.execute(
        f"SELECT DISTINCT task_id FROM task_decisions "
        f"WHERE status = ? AND task_id IN ({ph})",
        [DECISION_PENDING, *task_ids]).fetchall()
    return {r["task_id"]: True for r in rows}


def resolve_decision(conn: sqlite3.Connection, decision_id: str, resolution: str,
                     note: str | None = None) -> dict[str, Any] | None:
    """Resolve one pending decision (approved | declined). Returns the updated
    row, or None if it was not pending (already resolved / superseded)."""
    if resolution not in (DECISION_APPROVED, DECISION_DECLINED):
        raise ValueError(f"invalid decision resolution: {resolution!r}")
    cur = conn.execute(
        "UPDATE task_decisions SET status = ?, resolved_at = ?, resolution_note = ? "
        "WHERE id = ? AND status = ?",
        (resolution, utcnow(), redact_text(note or "")[:400] or None,
         decision_id, DECISION_PENDING))
    if cur.rowcount <= 0:
        return None
    return get_decision(conn, decision_id)


def _decision_dict(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"], "task_id": r["task_id"], "execution_id": r["execution_id"],
        "work_result_id": r["work_result_id"], "action_type": r["action_type"],
        "title": r["title"], "reason": r["reason"],
        "proposal": _loads(r["proposal_json_sanitized"], {}),
        "status": r["status"], "resolution_note": r["resolution_note"],
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
    return {
        "task_id": row["task_id"], "version": row["version"],
        "context": _loads(row["context_json_sanitized"], {}),
        "updated_by_execution_id": row["updated_by_execution_id"],
        "created_at": row["created_at"],
    }


def save_context_version(conn: sqlite3.Connection, task_id: str,
                         context_doc: dict[str, Any],
                         execution_id: str | None = None) -> int | None:
    """Persist a new context version IF it differs from the latest. Returns the
    new version number, or None when unchanged (no version churn)."""
    raw = _dumps(context_doc)
    latest = conn.execute(
        "SELECT version, context_json_sanitized FROM task_context_versions "
        "WHERE task_id = ? ORDER BY version DESC LIMIT 1", (task_id,)).fetchone()
    if latest is not None and latest["context_json_sanitized"] == raw:
        return None
    version = (int(latest["version"]) if latest is not None else 0) + 1
    conn.execute(
        "INSERT INTO task_context_versions (task_id, version, context_json_sanitized, "
        "updated_by_execution_id, created_at) VALUES (?, ?, ?, ?, ?)",
        (task_id, version, raw, execution_id, utcnow()),
    )
    conn.execute(
        "UPDATE agent_tasks SET context_version = ?, updated_at = ? WHERE id = ?",
        (version, utcnow(), task_id))
    return version
