"""Repository for session-scoped uploaded datasets (agent-native file analysis).

A file the user attaches in the conversation is recorded here against the
session, so the in-chat agent can discover and analyze it with its read-only
analysis tools (``session_analysis_tools``) and answer inline — instead of the
upload firing a fixed deterministic analysis run. Sanitized: only a stored file
path + metadata; never raw rows or secrets.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from . import utcnow


def _to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "dataset_type": row["dataset_type"],
        "source_filename": row["source_filename"],
        "stored_path": row["stored_path"],
        "duckdb_path": row["duckdb_path"],
        "table_name": row["table_name"],
        "row_count": row["row_count"],
        "detected_format": row["detected_format"],
        "status": row["status"],
        "created_at": row["created_at"],
    }


def create(
    conn: sqlite3.Connection,
    session_id: str,
    dataset_type: str,
    source_filename: str | None,
    stored_path_rel: str | None,
) -> str:
    dataset_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO session_datasets "
        "(id, session_id, dataset_type, source_filename, stored_path, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, 'uploaded', ?)",
        (dataset_id, session_id, dataset_type, source_filename, stored_path_rel, utcnow()),
    )
    return dataset_id


def mark_imported(
    conn: sqlite3.Connection,
    dataset_id: str,
    duckdb_path_rel: str,
    table_name: str,
    row_count: int,
    detected_format: str | None = None,
) -> None:
    conn.execute(
        "UPDATE session_datasets SET duckdb_path=?, table_name=?, row_count=?, "
        "detected_format=?, status='imported' WHERE id=?",
        (duckdb_path_rel, table_name, row_count, detected_format, dataset_id),
    )


def get(conn: sqlite3.Connection, dataset_id: str) -> dict[str, Any] | None:
    cur = conn.execute("SELECT * FROM session_datasets WHERE id=?", (dataset_id,))
    row = cur.fetchone()
    return _to_dict(row) if row else None


def list_for_session(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    cur = conn.execute(
        "SELECT * FROM session_datasets WHERE session_id=? ORDER BY rowid DESC",
        (session_id,),
    )
    return [_to_dict(r) for r in cur.fetchall()]


def list_pending_for_session(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    """Datasets uploaded but not yet analyzed — surfaced to the agent as the
    attachments for the current turn."""
    cur = conn.execute(
        "SELECT * FROM session_datasets WHERE session_id=? AND status='uploaded' ORDER BY rowid",
        (session_id,),
    )
    return [_to_dict(r) for r in cur.fetchall()]
