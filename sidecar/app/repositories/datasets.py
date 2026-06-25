"""Dataset metadata repository (Phase 05).

Stored paths are kept RELATIVE to the data dir so absolute, possibly
username-bearing paths never land in the database. Resolve with
``config.data_dir() / stored_path`` when opening files.
"""

from __future__ import annotations

import sqlite3
import uuid

from ..models.schemas import DatasetOut
from . import utcnow


def _to_out(row: sqlite3.Row) -> DatasetOut:
    return DatasetOut(
        id=row["id"],
        run_id=row["run_id"],
        dataset_type=row["dataset_type"],
        name=row["name"],
        source_filename=row["source_filename"],
        stored_path=row["stored_path"],
        duckdb_path=row["duckdb_path"],
        table_name=row["table_name"],
        row_count=row["row_count"],
        status=row["status"],
        created_at=row["created_at"],
    )


def create(
    conn: sqlite3.Connection,
    run_id: str,
    dataset_type: str,
    name: str | None,
    source_filename: str,
    stored_path_rel: str,
) -> str:
    dataset_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO datasets "
        "(id, run_id, dataset_type, name, source_filename, stored_path, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?)",
        (dataset_id, run_id, dataset_type, name, source_filename, stored_path_rel, utcnow()),
    )
    conn.commit()
    return dataset_id


def mark_imported(
    conn: sqlite3.Connection,
    dataset_id: str,
    duckdb_path_rel: str,
    table_name: str,
    row_count: int,
) -> None:
    conn.execute(
        "UPDATE datasets SET duckdb_path=?, table_name=?, row_count=?, status='imported' WHERE id=?",
        (duckdb_path_rel, table_name, row_count, dataset_id),
    )
    conn.commit()


def get(conn: sqlite3.Connection, dataset_id: str) -> DatasetOut | None:
    row = conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
    return _to_out(row) if row else None


def list_all(conn: sqlite3.Connection) -> list[DatasetOut]:
    rows = conn.execute("SELECT * FROM datasets ORDER BY created_at DESC, rowid DESC").fetchall()
    return [_to_out(r) for r in rows]


def latest_for_run(
    conn: sqlite3.Connection, run_id: str, dataset_type: str | None = None
) -> DatasetOut | None:
    if dataset_type:
        row = conn.execute(
            "SELECT * FROM datasets WHERE run_id = ? AND dataset_type = ? ORDER BY rowid DESC LIMIT 1",
            (run_id, dataset_type),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM datasets WHERE run_id = ? ORDER BY rowid DESC LIMIT 1", (run_id,)
        ).fetchone()
    return _to_out(row) if row else None
