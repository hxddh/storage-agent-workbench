"""Session repository.

A Session is a persistent working context linking runs, evidence references,
findings, a deterministic summary, and a lightweight message thread. NOT a
project-management/kanban/ticketing system. Every JSON / content value is
redaction-passed before storage — never AK/SK/session token/Authorization/
cookies/presigned URL/model key, never raw logs / raw inventory rows /
chain-of-thought.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from ..models.schemas import SessionCreate, SessionUpdate
from ..security.redaction import redact, redact_text
from . import utcnow

# Map a run_type to its session role.
RUN_ROLE = {
    "account_discovery": "account_discovery",
    "inventory_analysis": "analysis",
    "access_log_analysis": "analysis",
    "bucket_config_review": "config_review",
    "diagnostic": "diagnostic",
}


def _dumps(value: Any) -> str:
    return json.dumps(redact(value), default=str)


def _touch(conn: sqlite3.Connection, session_id: str) -> None:
    conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (utcnow(), session_id))


# --- sessions ---------------------------------------------------------------


def create(conn: sqlite3.Connection, data: SessionCreate) -> str:
    session_id = uuid.uuid4().hex
    now = utcnow()
    conn.execute(
        "INSERT INTO sessions (id, title, goal, provider_id, primary_bucket, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
        (session_id, redact_text(data.title), redact_text(data.goal or "") or None,
         data.provider_id, redact_text(data.primary_bucket or "") or None, now, now),
    )
    conn.commit()
    return session_id


def update(conn: sqlite3.Connection, session_id: str, data: SessionUpdate) -> None:
    sets, params = [], []
    if data.title is not None:
        sets.append("title = ?"); params.append(redact_text(data.title))
    if data.goal is not None:
        sets.append("goal = ?"); params.append(redact_text(data.goal))
    if data.provider_id is not None:
        sets.append("provider_id = ?"); params.append(data.provider_id)
    if data.primary_bucket is not None:
        sets.append("primary_bucket = ?"); params.append(redact_text(data.primary_bucket))
    if data.status is not None:
        sets.append("status = ?"); params.append(data.status)
    if data.pinned is not None:
        sets.append("pinned = ?"); params.append(1 if data.pinned else 0)
    if not sets:
        return
    sets.append("updated_at = ?"); params.append(utcnow())
    params.append(session_id)
    conn.execute(f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()


def delete(conn: sqlite3.Connection, session_id: str) -> None:
    """Delete a session and all its child rows (thread, runs links, findings,
    evidence refs, summary). Run records themselves are not deleted."""
    for tbl in ("session_messages", "session_runs", "session_findings",
                "session_evidence_refs", "session_summaries"):
        conn.execute(f"DELETE FROM {tbl} WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    conn.commit()


def fork(conn: sqlite3.Connection, session_id: str) -> str | None:
    """Create a new session that copies another's title/goal/provider, its full
    message thread, and the agent's working memory, so a branched conversation
    keeps its context. Runs, deterministic findings and the derived summary are
    NOT copied (they belong to the source's runs)."""
    src = get_row(conn, session_id)
    if src is None:
        return None
    new_id = uuid.uuid4().hex
    now = utcnow()
    title = (src["title"] or "Untitled")[:160] + " (fork)"
    conn.execute(
        "INSERT INTO sessions (id, title, goal, provider_id, primary_bucket, status, pinned, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)",
        (new_id, title, src["goal"], src["provider_id"], src["primary_bucket"], now, now),
    )
    msgs = conn.execute(
        "SELECT role, content, referenced_run_ids, referenced_evidence_ids, tool_activity, created_at "
        "FROM session_messages WHERE session_id = ? ORDER BY rowid", (session_id,)
    ).fetchall()
    for m in msgs:
        keys = m.keys()
        conn.execute(
            "INSERT INTO session_messages "
            "(id, session_id, role, content, referenced_run_ids, referenced_evidence_ids, tool_activity, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, new_id, m["role"], m["content"],
             m["referenced_run_ids"], m["referenced_evidence_ids"],
             (m["tool_activity"] if "tool_activity" in keys else None), m["created_at"]),
        )
    # Copy the agent's working memory so a fork doesn't lose what the agent learned.
    mem = conn.execute(
        "SELECT kind, text, severity, confidence, source_run_id, status, created_at "
        "FROM session_agent_memory WHERE session_id = ? AND status = 'active' ORDER BY rowid",
        (session_id,),
    ).fetchall()
    for r in mem:
        conn.execute(
            "INSERT INTO session_agent_memory "
            "(id, session_id, kind, text, severity, confidence, source_run_id, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, new_id, r["kind"], r["text"], r["severity"],
             r["confidence"], r["source_run_id"], r["status"], r["created_at"]),
        )
    # Copy uploaded datasets (rows + the raw files on disk) so a forked
    # conversation keeps the files the agent analyzed. The copied file lands in
    # the new session's raw dir and the row points at it; analysis re-derives the
    # DuckDB table on demand, so duckdb_path/table_name reset to 'uploaded'.
    from .. import config
    ds_rows = conn.execute(
        "SELECT dataset_type, source_filename, stored_path, detected_format "
        "FROM session_datasets WHERE session_id = ? ORDER BY rowid", (session_id,)
    ).fetchall()
    for d in ds_rows:
        new_stored_rel = d["stored_path"]
        if d["stored_path"]:
            src_abs = config.data_dir() / d["stored_path"]
            if src_abs.exists():
                dest_dir = config.data_dir() / "sessions" / new_id / "raw"
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest_abs = dest_dir / Path(d["stored_path"]).name
                shutil.copy2(src_abs, dest_abs)
                new_stored_rel = config.rel_path(dest_abs)
        conn.execute(
            "INSERT INTO session_datasets "
            "(id, session_id, dataset_type, source_filename, stored_path, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'uploaded', ?)",
            (uuid.uuid4().hex, new_id, d["dataset_type"], d["source_filename"],
             new_stored_rel, now),
        )
    conn.commit()
    return new_id


def get_row(conn: sqlite3.Connection, session_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()


def _enrich(conn: sqlite3.Connection, rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    out = []
    for r in rows:
        d = dict(r)
        d["run_count"] = conn.execute(
            "SELECT count(*) FROM session_runs WHERE session_id = ?", (r["id"],)).fetchone()[0]
        d["finding_count"] = conn.execute(
            "SELECT count(*) FROM session_findings WHERE session_id = ? AND status = 'active'",
            (r["id"],)).fetchone()[0]
        out.append(d)
    return out


def list_all(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC, rowid DESC"
    ).fetchall()
    return _enrich(conn, rows)


def search(conn: sqlite3.Connection, query: str | None) -> list[dict[str, Any]]:
    """Sessions whose title OR any message content matches `query` (substring,
    case-insensitive). Empty query returns the full list."""
    q = (query or "").strip()
    if not q:
        return list_all(conn)
    # Escape LIKE wildcards so a literal % or _ in the query isn't treated as one.
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    like = f"%{esc}%"
    rows = conn.execute(
        "SELECT s.* FROM sessions s "
        "WHERE s.title LIKE ? ESCAPE '\\' "
        "   OR EXISTS (SELECT 1 FROM session_messages m "
        "              WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\') "
        "ORDER BY s.pinned DESC, s.updated_at DESC, s.rowid DESC",
        (like, like),
    ).fetchall()
    return _enrich(conn, rows)


def title_for(conn: sqlite3.Connection, session_id: str | None) -> str | None:
    if not session_id:
        return None
    row = conn.execute("SELECT title FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return row["title"] if row else None


# --- session_runs -----------------------------------------------------------


def link_run(conn: sqlite3.Connection, session_id: str, run_id: str, role: str | None) -> None:
    existing = conn.execute(
        "SELECT 1 FROM session_runs WHERE session_id = ? AND run_id = ?", (session_id, run_id)
    ).fetchone()
    if existing:
        return
    conn.execute(
        "INSERT INTO session_runs (id, session_id, run_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
        (uuid.uuid4().hex, session_id, run_id, role, utcnow()),
    )
    _touch(conn, session_id)
    conn.commit()


def list_runs(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT sr.run_id, sr.role, sr.created_at AS linked_at, "
        "       r.run_type, r.status, r.title, r.final_summary, r.origin "
        "FROM session_runs sr JOIN runs r ON r.id = sr.run_id "
        "WHERE sr.session_id = ? ORDER BY sr.rowid",
        (session_id,),
    ).fetchall()
    return [
        {
            "run_id": r["run_id"], "role": r["role"], "run_type": r["run_type"],
            "status": r["status"], "title": r["title"], "final_summary": r["final_summary"],
            "origin": r["origin"], "created_at": r["linked_at"],
        }
        for r in rows
    ]


# --- evidence refs (rebuilt on each summary refresh) ------------------------


def replace_evidence_refs(conn: sqlite3.Connection, session_id: str, refs: list[dict[str, Any]]) -> None:
    conn.execute("DELETE FROM session_evidence_refs WHERE session_id = ?", (session_id,))
    for ref in refs:
        conn.execute(
            "INSERT INTO session_evidence_refs "
            "(id, session_id, source_type, source_id, source_run_id, summary_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, session_id, ref.get("source_type"), ref.get("source_id"),
             ref.get("source_run_id"), _dumps(ref.get("summary", {})), utcnow()),
        )
    conn.commit()


# --- findings (rebuilt on each summary refresh) -----------------------------


def replace_findings(conn: sqlite3.Connection, session_id: str, findings: list[dict[str, Any]]) -> None:
    conn.execute("DELETE FROM session_findings WHERE session_id = ?", (session_id,))
    for f in findings:
        conn.execute(
            "INSERT INTO session_findings "
            "(id, session_id, source_run_id, category, severity, confidence, kind, title, "
            " evidence_json, interpretation, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
            (uuid.uuid4().hex, session_id, f.get("source_run_id"), f.get("category"),
             f.get("severity"), f.get("confidence"), f.get("kind"),
             redact_text(str(f.get("title", "")))[:300], _dumps(f.get("evidence", {})),
             redact_text(str(f.get("interpretation", "")))[:600], utcnow()),
        )
    conn.commit()


def list_findings(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM session_findings WHERE session_id = ? AND status = 'active' ORDER BY rowid",
        (session_id,),
    ).fetchall()
    return [dict(r) for r in rows]


# --- summary ----------------------------------------------------------------


def upsert_summary(conn: sqlite3.Connection, session_id: str, summary: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO session_summaries "
        "(session_id, summary_md, known_facts_json, open_questions_json, next_actions_json, "
        " findings_json, limitations_json, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(session_id) DO UPDATE SET "
        " summary_md=excluded.summary_md, known_facts_json=excluded.known_facts_json, "
        " open_questions_json=excluded.open_questions_json, next_actions_json=excluded.next_actions_json, "
        " findings_json=excluded.findings_json, limitations_json=excluded.limitations_json, "
        " updated_at=excluded.updated_at",
        (session_id, redact_text(summary.get("summary_md", "")),
         _dumps(summary.get("known_facts", [])), _dumps(summary.get("open_questions", [])),
         _dumps(summary.get("next_actions", [])), _dumps(summary.get("findings", [])),
         _dumps(summary.get("limitations", [])), utcnow()),
    )
    _touch(conn, session_id)
    conn.commit()


def get_summary(conn: sqlite3.Connection, session_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM session_summaries WHERE session_id = ?", (session_id,)).fetchone()
    if row is None:
        return None
    return {
        "session_id": session_id,
        "summary_md": row["summary_md"] or "",
        "known_facts": json.loads(row["known_facts_json"] or "[]"),
        "open_questions": json.loads(row["open_questions_json"] or "[]"),
        "next_actions": json.loads(row["next_actions_json"] or "[]"),
        "findings": json.loads(row["findings_json"] or "[]"),
        "limitations": json.loads(row["limitations_json"] or "[]"),
        "updated_at": row["updated_at"],
    }


# --- messages ---------------------------------------------------------------


def add_message(
    conn: sqlite3.Connection,
    session_id: str,
    role: str,
    content: str,
    referenced_run_ids: list[str] | None = None,
    referenced_evidence_ids: list[str] | None = None,
    tool_activity: list[dict[str, Any]] | None = None,
    grounding: dict[str, Any] | None = None,
    proposed_actions: list[dict[str, Any]] | None = None,
) -> str:
    msg_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO session_messages "
        "(id, session_id, role, content, referenced_run_ids, referenced_evidence_ids, "
        " tool_activity, grounding, proposed_actions, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (msg_id, session_id, role, redact_text(content or ""),
         json.dumps(referenced_run_ids or []), json.dumps(referenced_evidence_ids or []),
         json.dumps(tool_activity or []),
         json.dumps(grounding) if grounding is not None else None,
         json.dumps(proposed_actions) if proposed_actions is not None else None,
         utcnow()),
    )
    _touch(conn, session_id)
    conn.commit()
    return msg_id


# --- agent working memory ---------------------------------------------------
#
# Facts/findings/open-questions the in-chat agent records itself as it
# investigates (kind in {'fact','finding','open_question'}). Kept separate from
# the deterministic session_findings/session_summaries (which are rebuilt from
# run artifacts and would wipe these). Always redacted; never secrets/raw rows.

_MEMORY_KINDS = ("fact", "finding", "open_question")


def add_agent_memory(
    conn: sqlite3.Connection,
    session_id: str,
    kind: str,
    text: str,
    *,
    severity: str | None = None,
    confidence: str | None = None,
    source_run_id: str | None = None,
) -> str:
    """Persist one agent-authored memory item (sanitized). Returns its id.

    Deduped: an exact-duplicate ACTIVE item of the same kind/text is not
    re-inserted — the existing id is returned instead, so a re-derived fact
    doesn't pile up identical rows against the tail cap.
    """
    if kind not in _MEMORY_KINDS:
        raise ValueError(f"unknown agent-memory kind: {kind!r}")
    clean = redact_text(str(text))[:600]
    existing = conn.execute(
        "SELECT id FROM session_agent_memory "
        "WHERE session_id = ? AND kind = ? AND text = ? AND status = 'active' LIMIT 1",
        (session_id, kind, clean),
    ).fetchone()
    if existing is not None:
        return existing["id"]
    mem_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO session_agent_memory "
        "(id, session_id, kind, text, severity, confidence, source_run_id, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
        (mem_id, session_id, kind, clean,
         (severity or None), (confidence or None), (source_run_id or None), utcnow()),
    )
    _touch(conn, session_id)
    conn.commit()
    return mem_id


def update_agent_memory(
    conn: sqlite3.Connection, session_id: str, mem_id: str, new_text: str
) -> bool:
    """Correct an active memory item's text (sanitized). Returns True if updated."""
    clean = redact_text(str(new_text))[:600]
    cur = conn.execute(
        "UPDATE session_agent_memory SET text = ? "
        "WHERE id = ? AND session_id = ? AND status = 'active'",
        (clean, mem_id, session_id),
    )
    _touch(conn, session_id)
    conn.commit()
    return cur.rowcount > 0


def resolve_agent_memory(
    conn: sqlite3.Connection, session_id: str, mem_id: str, reason: str | None = None
) -> bool:
    """Close/resolve a memory item so it stops being replayed and no longer
    counts against the active tail cap. Returns True if a row was resolved.

    The optional ``reason`` is appended (sanitized) to the item's text so the
    resolution stays auditable even though the item leaves the active set.
    """
    row = conn.execute(
        "SELECT text FROM session_agent_memory "
        "WHERE id = ? AND session_id = ? AND status = 'active'",
        (mem_id, session_id),
    ).fetchone()
    if row is None:
        return False
    text = row["text"]
    if reason:
        text = f"{text} [resolved: {redact_text(str(reason))[:200]}]"[:600]
    conn.execute(
        "UPDATE session_agent_memory SET status = 'resolved', text = ? "
        "WHERE id = ? AND session_id = ?",
        (text, mem_id, session_id),
    )
    _touch(conn, session_id)
    conn.commit()
    return True


def list_agent_memory(
    conn: sqlite3.Connection, session_id: str, limit: int = 50
) -> list[dict[str, Any]]:
    """The most recent ``limit`` ACTIVE agent-memory items, returned oldest-first.

    Resolved/closed items are excluded (they neither replay into context nor
    count against the tail cap). Bounded so a long-running session can't grow the
    per-turn context (or its build cost) without limit; the newest items survive.
    """
    rows = conn.execute(
        "SELECT * FROM session_agent_memory WHERE session_id = ? AND status = 'active' "
        "ORDER BY rowid DESC LIMIT ?",
        (session_id, max(1, int(limit))),
    ).fetchall()
    return [dict(r) for r in reversed(rows)]


def list_messages(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM session_messages WHERE session_id = ? ORDER BY rowid", (session_id,)
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        keys = r.keys()
        out.append({
            "id": r["id"], "role": r["role"], "content": r["content"],
            "referenced_run_ids": json.loads(r["referenced_run_ids"] or "[]"),
            "referenced_evidence_ids": json.loads(r["referenced_evidence_ids"] or "[]"),
            "tool_activity": json.loads((r["tool_activity"] if "tool_activity" in keys else None) or "[]"),
            "grounding": json.loads(r["grounding"]) if ("grounding" in keys and r["grounding"]) else None,
            "proposed_actions": json.loads(r["proposed_actions"]) if ("proposed_actions" in keys and r["proposed_actions"]) else [],
            "created_at": r["created_at"],
        })
    return out
