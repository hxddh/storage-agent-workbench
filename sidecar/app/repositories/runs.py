"""Run + message repository (Phase 04)."""

from __future__ import annotations

import json
import sqlite3
import uuid

from ..models.schemas import (
    MessageOut,
    RunCreate,
    RunDetail,
    RunSummary,
    ToolCallOut,
)
from . import utcnow


def _summary(row: sqlite3.Row) -> RunSummary:
    return RunSummary(
        id=row["id"],
        run_type=row["run_type"],
        title=row["title"],
        status=row["status"],
        provider_id=row["provider_id"],
        bucket=row["bucket"],
        final_summary=row["final_summary"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _options_json(data: RunCreate) -> str | None:
    """Serialize bounded, non-secret run options (e.g. account_discovery)."""
    options: dict[str, object] = {}
    if data.max_buckets is not None:
        options["max_buckets"] = data.max_buckets
    if data.include_pattern:
        options["include_pattern"] = data.include_pattern
    if data.exclude_pattern:
        options["exclude_pattern"] = data.exclude_pattern
    return json.dumps(options) if options else None


def create(conn: sqlite3.Connection, data: RunCreate, status: str, origin: str = "user") -> str:
    run_id = uuid.uuid4().hex
    now = utcnow()
    # planner_mode column kept in the schema for back-compat but unused — there is
    # no LLM planner; it defaults to 'deterministic'. Not written here.
    conn.execute(
        "INSERT INTO runs "
        "(id, run_type, title, status, provider_id, bucket, prefix, "
        " user_prompt, final_summary, report_path, options_json, session_id, origin, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)",
        (
            run_id,
            data.run_type,
            data.title,
            status,
            data.provider_id,
            data.bucket,
            data.prefix,
            data.user_prompt,
            _options_json(data),
            data.session_id,
            origin,
            now,
            now,
        ),
    )
    conn.commit()
    return run_id


def list_all(conn: sqlite3.Connection) -> list[RunSummary]:
    rows = conn.execute("SELECT * FROM runs ORDER BY created_at DESC, id").fetchall()
    return [_summary(r) for r in rows]


def get_row(conn: sqlite3.Connection, run_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()


def get_detail(conn: sqlite3.Connection, run_id: str) -> RunDetail | None:
    row = get_row(conn, run_id)
    if row is None:
        return None
    messages = [
        MessageOut(id=m["id"], role=m["role"], content=m["content"], created_at=m["created_at"])
        for m in conn.execute(
            "SELECT * FROM messages WHERE run_id = ? ORDER BY rowid", (run_id,)
        ).fetchall()
    ]
    tool_calls = [
        ToolCallOut(
            id=t["id"],
            tool_name=t["tool_name"],
            input_json_sanitized=t["input_json_sanitized"],
            output_json_sanitized=t["output_json_sanitized"],
            status=t["status"],
            duration_ms=t["duration_ms"],
            created_at=t["created_at"],
        )
        for t in conn.execute(
            "SELECT * FROM tool_calls WHERE run_id = ? ORDER BY rowid", (run_id,)
        ).fetchall()
    ]
    return RunDetail(
        id=row["id"],
        run_type=row["run_type"],
        title=row["title"],
        status=row["status"],
        provider_id=row["provider_id"],
        bucket=row["bucket"],
        prefix=row["prefix"],
        user_prompt=row["user_prompt"],
        final_summary=row["final_summary"],
        report_path=row["report_path"],
        session_id=row["session_id"],
        session_title=_session_title(conn, row["session_id"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        messages=messages,
        tool_calls=tool_calls,
    )


def _session_title(conn: sqlite3.Connection, session_id: str | None) -> str | None:
    if not session_id:
        return None
    row = conn.execute("SELECT title FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return row["title"] if row else None


def add_message(conn: sqlite3.Connection, run_id: str, role: str, content: str) -> str:
    msg_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO messages (id, run_id, role, content, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (msg_id, run_id, role, content, utcnow()),
    )
    conn.commit()
    return msg_id


def set_status(
    conn: sqlite3.Connection,
    run_id: str,
    status: str,
    final_summary: str | None = None,
    report_path: str | None = None,
) -> None:
    fields = ["status = ?", "updated_at = ?"]
    params: list[object] = [status, utcnow()]
    if final_summary is not None:
        fields.append("final_summary = ?")
        params.append(final_summary)
    if report_path is not None:
        fields.append("report_path = ?")
        params.append(report_path)
    params.append(run_id)
    conn.execute(f"UPDATE runs SET {', '.join(fields)} WHERE id = ?", params)
    conn.commit()
