"""Tasks, turns and the item stream — the one source of truth (v5).

Everything the product shows is a projection of `items`: the task page, the
report, the audit view, the trace export. Items are append-only; a live
agent message is streamed as deltas over the hub and written once, whole,
when its segment closes.

Payloads are sanitized before they get here (see `agent.safety`); this module
still bounds every payload so a caller mistake cannot bloat the database.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any, Iterable

from ..core.clock import utcnow

ITEM_TYPES = frozenset({
    "user_message",     # the Direction (or a steer, see "steer")
    "agent_message",    # model text: commentary segment or the final answer
    "tool_call",        # the model asked for a tool
    "tool_progress",    # counts the engine reported while working
    "tool_output",      # the tool's result (sanitized summary + model-facing output)
    "conclusion",       # the structured conclusion the model recorded
    "steer",            # a Direction given while the turn was running
    "compaction",       # older history folded into a summary
    "notice",           # runtime notes: resumed, stopped, queued, title
    "error",            # a turn failure, user-readable
})

TURN_STATUSES = ("queued", "running", "completed", "failed", "cancelled", "interrupted")
ACTIVE_TURN = ("queued", "running")
_MAX_PAYLOAD_CHARS = 400_000


def new_id() -> str:
    return uuid.uuid4().hex


def _dumps(value: Any) -> str:
    text = json.dumps(value, separators=(",", ":"), default=str, ensure_ascii=False)
    if len(text) > _MAX_PAYLOAD_CHARS:
        # Bounded, never silently: the reader sees that it was cut.
        text = json.dumps({"truncated": True, "chars": len(text),
                           "head": text[:_MAX_PAYLOAD_CHARS // 2]}, ensure_ascii=False)
    return text


def loads(raw: str | None, default: Any = None) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


# --- tasks ------------------------------------------------------------------------

def create_task(conn: sqlite3.Connection, title: str, *, origin: str = "user") -> dict[str, Any]:
    now = utcnow()
    tid = new_id()
    conn.execute("INSERT INTO tasks (id, title, title_source, origin, created_at, updated_at) "
                 "VALUES (?, ?, 'seed', ?, ?, ?)", (tid, (title or "New task")[:120], origin, now, now))
    conn.commit()
    return get_task(conn, tid)  # type: ignore[return-value]


def get_task(conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return dict(row) if row else None


def list_tasks(conn: sqlite3.Connection, *, query: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
    """Tasks newest-first with their live state (derived from their turns)."""
    sql = ("SELECT t.*, "
           " (SELECT status FROM turns WHERE task_id = t.id AND status IN ('running','queued') "
           "  ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END LIMIT 1) AS live_status, "
           " (SELECT status FROM turns WHERE id = t.head_turn_id) AS last_status "
           "FROM tasks t")
    args: list[Any] = []
    if query:
        sql += " WHERE t.title LIKE ?"
        args.append(f"%{query}%")
    sql += " ORDER BY t.updated_at DESC LIMIT ?"
    args.append(max(1, min(int(limit), 2000)))
    return [dict(r) | {"state": task_state(r["live_status"], r["last_status"])}
            for r in conn.execute(sql, args).fetchall()]


def head_status(conn: sqlite3.Connection, task_id: str) -> str | None:
    """The status of the turn the task is read at: a failure on a branch the user
    has moved away from never makes the task need attention."""
    row = conn.execute("SELECT t.status FROM turns t JOIN tasks k ON k.head_turn_id = t.id WHERE k.id = ?",
                       (task_id,)).fetchone()
    return row["status"] if row else None


def task_state(live: str | None, last: str | None) -> str:
    if live == "running":
        return "working"
    if live == "queued":
        return "queued"
    if last in ("failed", "interrupted"):
        return "needs_attention"
    return "ready"


def rename_task(conn: sqlite3.Connection, task_id: str, title: str, *, source: str = "user") -> bool:
    title = (title or "").strip()[:120]
    if not title:
        return False
    if source == "agent":
        # A user rename wins forever.
        n = conn.execute("UPDATE tasks SET title = ?, title_source = 'agent', updated_at = ? "
                         "WHERE id = ? AND title_source != 'user'", (title, utcnow(), task_id)).rowcount
    else:
        n = conn.execute("UPDATE tasks SET title = ?, title_source = ?, updated_at = ? WHERE id = ?",
                         (title, source, utcnow(), task_id)).rowcount
    conn.commit()
    return n > 0


def touch_task(conn: sqlite3.Connection, task_id: str) -> None:
    conn.execute("UPDATE tasks SET updated_at = ? WHERE id = ?", (utcnow(), task_id))


def delete_task(conn: sqlite3.Connection, task_id: str) -> bool:
    n = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,)).rowcount
    conn.commit()
    return n > 0


# --- turns ------------------------------------------------------------------------

def create_turn(conn: sqlite3.Connection, task_id: str, direction: str, *, kind: str = "direction",
                parent_turn_id: str | None = None, status: str = "queued",
                resumed_from: str | None = None) -> dict[str, Any]:
    """A new turn on the task's branch. Without an explicit parent it continues
    from the task's head (the latest turn of the branch being read); with one
    it forks: the new turn becomes a sibling branch, and the head moves to it."""
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError("task not found")
    parent = parent_turn_id if parent_turn_id is not None else task["head_turn_id"]
    if parent_turn_id == "":
        parent = None  # an explicit fork from the very start
    turn_id = new_id()
    now = utcnow()
    conn.execute(
        "INSERT INTO turns (id, task_id, parent_turn_id, kind, direction, status, resumed_from, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (turn_id, task_id, parent, kind, direction, status, resumed_from, now))
    conn.execute("UPDATE tasks SET head_turn_id = ?, updated_at = ? WHERE id = ?", (turn_id, now, task_id))
    conn.commit()
    return get_turn(conn, turn_id)  # type: ignore[return-value]


TURN_FIELDS = ("id", "parent_turn_id", "kind", "direction", "status", "error", "created_at",
               "started_at", "finished_at", "resumed_from")


def turn_public(turn: dict[str, Any]) -> dict[str, Any]:
    """A turn as the window reads it (snapshot and the live ``turn`` event)."""
    return {k: turn.get(k) for k in TURN_FIELDS} | {"usage": loads(turn.get("usage_json"))}


def reparent_children(conn: sqlite3.Connection, turn_id: str, new_parent: str | None) -> list[str]:
    """Move a turn's children onto ``new_parent``; returns the moved turn ids."""
    ids = [r["id"] for r in conn.execute("SELECT id FROM turns WHERE parent_turn_id = ?", (turn_id,)).fetchall()]
    if ids:
        conn.execute("UPDATE turns SET parent_turn_id = ? WHERE parent_turn_id = ?", (new_parent, turn_id))
        conn.commit()
    return ids


def get_turn(conn: sqlite3.Connection, turn_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM turns WHERE id = ?", (turn_id,)).fetchone()
    return dict(row) if row else None


def set_turn_status(conn: sqlite3.Connection, turn_id: str, status: str, *,
                    error: str | None = None, usage: dict[str, Any] | None = None) -> None:
    now = utcnow()
    sets = ["status = ?"]
    args: list[Any] = [status]
    if status == "running":
        sets.append("started_at = COALESCE(started_at, ?)")
        args.append(now)
    if status in ("completed", "failed", "cancelled", "interrupted"):
        sets.append("finished_at = ?")
        args.append(now)
    if error is not None:
        sets.append("error = ?")
        args.append(error[:2000])
    if usage is not None:
        sets.append("usage_json = ?")
        args.append(_dumps(usage))
    args.append(turn_id)
    conn.execute(f"UPDATE turns SET {', '.join(sets)} WHERE id = ?", args)
    conn.commit()


def branch(conn: sqlite3.Connection, task_id: str, head_turn_id: str | None = None) -> list[dict[str, Any]]:
    """The turns of one branch, oldest first: the chain from the head to the root."""
    rows = {r["id"]: dict(r) for r in conn.execute(
        "SELECT * FROM turns WHERE task_id = ?", (task_id,)).fetchall()}
    if head_turn_id is None:
        task = get_task(conn, task_id)
        head_turn_id = task["head_turn_id"] if task else None
    chain: list[dict[str, Any]] = []
    seen: set[str] = set()
    cur = head_turn_id
    while cur and cur in rows and cur not in seen:
        seen.add(cur)
        chain.append(rows[cur])
        cur = rows[cur]["parent_turn_id"]
    chain.reverse()
    return chain


def siblings(conn: sqlite3.Connection, task_id: str) -> dict[str, list[str]]:
    """For each parent (or the root, key ''), its child turns in creation order.
    A Direction with more than one version is a fork point."""
    out: dict[str, list[str]] = {}
    for r in conn.execute("SELECT id, parent_turn_id FROM turns WHERE task_id = ? AND kind != 'resume' "
                          "ORDER BY created_at, rowid", (task_id,)).fetchall():
        out.setdefault(r["parent_turn_id"] or "", []).append(r["id"])
    return out


def leaf_of(conn: sqlite3.Connection, task_id: str, turn_id: str) -> str:
    """The newest descendant of a turn — switching to a branch opens its tip."""
    children: dict[str, list[str]] = {}
    for r in conn.execute("SELECT id, parent_turn_id FROM turns WHERE task_id = ? ORDER BY created_at, rowid",
                          (task_id,)).fetchall():
        children.setdefault(r["parent_turn_id"] or "", []).append(r["id"])
    cur = turn_id
    while children.get(cur):
        cur = children[cur][-1]
    return cur


def set_head(conn: sqlite3.Connection, task_id: str, turn_id: str) -> None:
    conn.execute("UPDATE tasks SET head_turn_id = ?, updated_at = ? WHERE id = ?", (turn_id, utcnow(), task_id))
    conn.commit()


def active_turns(conn: sqlite3.Connection, task_id: str) -> list[dict[str, Any]]:
    return [dict(r) for r in conn.execute(
        "SELECT * FROM turns WHERE task_id = ? AND status IN ('queued','running') ORDER BY created_at, rowid",
        (task_id,)).fetchall()]


# --- items ------------------------------------------------------------------------

def append_item(conn: sqlite3.Connection, task_id: str, turn_id: str | None, type_: str,
                payload: dict[str, Any], *, item_id: str | None = None, commit: bool = True) -> dict[str, Any]:
    if type_ not in ITEM_TYPES:
        raise ValueError(f"unknown item type {type_}")
    iid = item_id or new_id()
    now = utcnow()
    cur = conn.execute("INSERT INTO items (id, task_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                       (iid, task_id, turn_id, type_, _dumps(payload), now))
    if commit:
        conn.commit()
    return {"seq": cur.lastrowid, "id": iid, "task_id": task_id, "turn_id": turn_id,
            "type": type_, "payload": payload, "created_at": now}


def items_for_turns(conn: sqlite3.Connection, turn_ids: Iterable[str]) -> list[dict[str, Any]]:
    """Items of the given turns in TURN order (the order given — a branch, oldest
    first), then by seq within a turn. Seq alone interleaves a follow-up queued
    while an earlier turn ran into that turn's items."""
    ids = list(turn_ids)
    if not ids:
        return []
    order = {tid: n for n, tid in enumerate(ids)}
    marks = ",".join("?" * len(ids))
    rows = conn.execute(f"SELECT * FROM items WHERE turn_id IN ({marks}) ORDER BY seq", ids).fetchall()
    return sorted((_item(r) for r in rows), key=lambda it: (order[it["turn_id"]], it["seq"]))


def items_after(conn: sqlite3.Connection, task_id: str, after: int, limit: int = 2000) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM items WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                        (task_id, int(after), int(limit))).fetchall()
    return [_item(r) for r in rows]


def _item(row: sqlite3.Row) -> dict[str, Any]:
    return {"seq": row["seq"], "id": row["id"], "task_id": row["task_id"], "turn_id": row["turn_id"],
            "type": row["type"], "payload": loads(row["payload"], {}), "created_at": row["created_at"]}


def last_seq(conn: sqlite3.Connection, task_id: str) -> int:
    row = conn.execute("SELECT MAX(seq) FROM items WHERE task_id = ?", (task_id,)).fetchone()
    return int(row[0] or 0)


# --- artifacts ----------------------------------------------------------------------

def add_artifact(conn: sqlite3.Connection, *, kind: str, title: str, task_id: str | None = None,
                 turn_id: str | None = None, provider_id: str | None = None,
                 payload: Any = None, path: str | None = None) -> str:
    aid = new_id()
    conn.execute("INSERT INTO artifacts (id, task_id, turn_id, kind, title, provider_id, payload, path, created_at) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (aid, task_id, turn_id, kind, title[:200], provider_id,
                  _dumps(payload) if payload is not None else None, path, utcnow()))
    conn.commit()
    return aid


def list_artifacts(conn: sqlite3.Connection, task_id: str) -> list[dict[str, Any]]:
    return [{**dict(r), "payload": loads(r["payload"])} for r in conn.execute(
        "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at", (task_id,)).fetchall()]


# --- audit --------------------------------------------------------------------------

def audit(conn: sqlite3.Connection, *, actor: str, action: str, task_id: str | None = None,
          target: str | None = None, ok: bool = True, duration_ms: int | None = None,
          detail: Any = None, commit: bool = True) -> None:
    conn.execute("INSERT INTO audit (at, actor, action, task_id, target, ok, duration_ms, detail) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                 (utcnow(), actor, action[:120], task_id, (target or "")[:300] or None, 1 if ok else 0,
                  duration_ms, _dumps(detail) if detail is not None else None))
    if commit:
        conn.commit()
