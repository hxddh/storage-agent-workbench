"""Session repository (Phase 16).

A Session is a persistent working context linking runs, evidence references,
findings, a deterministic summary, and a lightweight message thread. NOT a
project-management/kanban/ticketing system. Every JSON / content value is
redaction-passed before storage — never AK/SK/session token/Authorization/
cookies/presigned URL/model key, never raw logs / raw inventory rows /
chain-of-thought.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
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
    if not sets:
        return
    sets.append("updated_at = ?"); params.append(utcnow())
    params.append(session_id)
    conn.execute(f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()


def get_row(conn: sqlite3.Connection, session_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()


def list_all(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM sessions ORDER BY updated_at DESC, rowid DESC").fetchall()
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
        "       r.run_type, r.status, r.title, r.final_summary "
        "FROM session_runs sr JOIN runs r ON r.id = sr.run_id "
        "WHERE sr.session_id = ? ORDER BY sr.rowid",
        (session_id,),
    ).fetchall()
    return [
        {
            "run_id": r["run_id"], "role": r["role"], "run_type": r["run_type"],
            "status": r["status"], "title": r["title"], "final_summary": r["final_summary"],
            "created_at": r["linked_at"],
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
) -> str:
    msg_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO session_messages "
        "(id, session_id, role, content, referenced_run_ids, referenced_evidence_ids, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (msg_id, session_id, role, redact_text(content or ""),
         json.dumps(referenced_run_ids or []), json.dumps(referenced_evidence_ids or []), utcnow()),
    )
    _touch(conn, session_id)
    conn.commit()
    return msg_id


def list_messages(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM session_messages WHERE session_id = ? ORDER BY rowid", (session_id,)
    ).fetchall()
    return [
        {
            "id": r["id"], "role": r["role"], "content": r["content"],
            "referenced_run_ids": json.loads(r["referenced_run_ids"] or "[]"),
            "referenced_evidence_ids": json.loads(r["referenced_evidence_ids"] or "[]"),
            "created_at": r["created_at"],
        }
        for r in rows
    ]
