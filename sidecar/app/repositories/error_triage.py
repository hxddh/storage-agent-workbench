"""Error-triage case + findings repository (Phase 18).

Stores ONLY the redacted pasted input and sanitized parsed signals / findings.
Never AK/SK/session token/Authorization/cookies/presigned URL/model key, never
the full raw sensitive log, never chain-of-thought. Not a ticketing system —
there is no assignee/board/status-machine.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from ..security.redaction import redact
from . import utcnow


def _dumps(value: Any) -> str:
    return json.dumps(redact(value), default=str)


def create_case(
    conn: sqlite3.Connection,
    *,
    session_id: str | None,
    provider_id: str | None,
    bucket: str | None,
    run_id: str | None,
    input_kind: str,
    raw_input_redacted: str,
    parsed: dict[str, Any],
    summary: str,
    planner_mode: str,
    status: str = "triaged",
) -> str:
    case_id = uuid.uuid4().hex
    now = utcnow()
    conn.execute(
        "INSERT INTO error_triage_cases "
        "(id, session_id, provider_id, bucket, run_id, input_kind, raw_input_redacted, "
        " parsed_json, summary, planner_mode, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (case_id, session_id, provider_id, bucket, run_id, input_kind,
         raw_input_redacted, _dumps(parsed), summary, planner_mode, status, now, now),
    )
    conn.commit()
    return case_id


def add_finding(conn: sqlite3.Connection, case_id: str, f: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO error_triage_findings "
        "(id, case_id, category, severity, confidence, title, evidence_json, "
        " interpretation, next_checks_json, source_refs_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (uuid.uuid4().hex, case_id, f.get("category"), f.get("severity"), f.get("confidence"),
         str(f.get("title", ""))[:300], _dumps(f.get("evidence", [])),
         str(f.get("interpretation", ""))[:600], _dumps(f.get("next_checks", [])),
         _dumps(f.get("source_refs", [])), utcnow()),
    )


def get_case(conn: sqlite3.Connection, case_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM error_triage_cases WHERE id = ?", (case_id,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["parsed"] = json.loads(data.get("parsed_json") or "{}")
    data["candidate_causes"] = [
        {
            "id": f["id"], "category": f["category"], "severity": f["severity"],
            "confidence": f["confidence"], "title": f["title"],
            "interpretation": f["interpretation"],
            "evidence": json.loads(f["evidence_json"] or "[]"),
            "next_checks": json.loads(f["next_checks_json"] or "[]"),
            "source_refs": json.loads(f["source_refs_json"] or "[]"),
        }
        for f in conn.execute(
            "SELECT * FROM error_triage_findings WHERE case_id = ? ORDER BY rowid", (case_id,)
        ).fetchall()
    ]
    return data


def list_for_session(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT id FROM error_triage_cases WHERE session_id = ? ORDER BY created_at DESC, rowid DESC",
        (session_id,),
    ).fetchall()
    return [get_case(conn, r["id"]) for r in rows]
