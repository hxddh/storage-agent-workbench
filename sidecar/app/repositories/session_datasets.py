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

from ..security.redaction import redact_text
from . import utcnow


def _clean_name(name: str | None) -> str | None:
    """Redact a user-chosen filename before persistence (rule 14): a file named
    after a secret must not carry it into SQLite or — via attached_files — the
    prompt. Consistent with the evidence-import path, which redacts its labels."""
    return redact_text(name) if name else name


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
        (dataset_id, session_id, dataset_type, _clean_name(source_filename),
         stored_path_rel, utcnow()),
    )
    return dataset_id


def upsert(
    conn: sqlite3.Connection,
    session_id: str,
    dataset_type: str,
    source_filename: str | None,
    stored_path_rel: str | None,
) -> str:
    """Create a dataset, or REUSE the existing row for the same (session,
    filename) — re-uploading a file overwrites it on disk, so we must not leave
    multiple rows pointing at one path. On reuse the row resets to 'uploaded'
    (dropping any stale imported DuckDB/table) so the next analysis re-derives it.
    """
    source_filename = _clean_name(source_filename)
    # `IS`, not `=`: with a NULL filename `= NULL` never matches, so a re-uploaded
    # nameless file would insert a second row pointing at the same overwritten
    # path — exactly what this dedupe exists to prevent.
    existing = conn.execute(
        "SELECT id FROM session_datasets WHERE session_id = ? AND source_filename IS ? "
        "ORDER BY rowid DESC LIMIT 1",
        (session_id, source_filename),
    ).fetchone()
    if existing is not None:
        conn.execute(
            "UPDATE session_datasets SET dataset_type = ?, stored_path = ?, "
            "duckdb_path = NULL, table_name = NULL, row_count = NULL, "
            "detected_format = NULL, status = 'uploaded' WHERE id = ?",
            (dataset_type, stored_path_rel, existing["id"]),
        )
        return existing["id"]
    return create(conn, session_id, dataset_type, source_filename, stored_path_rel)


def mark_imported(
    conn: sqlite3.Connection,
    dataset_id: str,
    duckdb_path_rel: str,
    table_name: str,
    row_count: int,
    detected_format: str | None = None,
    expected_stored_path: str | None = None,
) -> bool:
    """Flag a dataset imported. Returns True if the row was updated.

    ``expected_stored_path`` guards against a concurrent re-upload: if the caller
    imported ``expected_stored_path`` but the row's ``stored_path`` has since
    changed (a re-upload of the same filename overwrote it and reset status to
    'uploaded'), the UPDATE matches 0 rows and returns False — so a slow import of
    the OLD file can't stamp a stale table as freshly imported over the new one.
    """
    if expected_stored_path is not None:
        cur = conn.execute(
            "UPDATE session_datasets SET duckdb_path=?, table_name=?, row_count=?, "
            "detected_format=?, status='imported' WHERE id=? AND stored_path=?",
            (duckdb_path_rel, table_name, row_count, detected_format,
             dataset_id, expected_stored_path),
        )
    else:
        cur = conn.execute(
            "UPDATE session_datasets SET duckdb_path=?, table_name=?, row_count=?, "
            "detected_format=?, status='imported' WHERE id=?",
            (duckdb_path_rel, table_name, row_count, detected_format, dataset_id),
        )
    return cur.rowcount > 0


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
