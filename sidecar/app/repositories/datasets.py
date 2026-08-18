"""Dataset metadata repository.

Stored paths are kept RELATIVE to the data dir so absolute, possibly
username-bearing paths never land in the database. Resolve with
``config.data_dir() / stored_path`` when opening files.
"""

from __future__ import annotations

import sqlite3
import uuid

from ..models.schemas import DatasetOut
from . import utcnow


def _bool_or_none(v: object) -> bool | None:
    """SQLite has no boolean. Keep NULL distinct from 0 — "never recorded" is not
    the same claim as "checked, and it was not truncated"."""
    return None if v is None else bool(v)


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
        # Whether the import stopped at the row ceiling, and where that ceiling
        # was. NULL = imported before these columns existed, which is UNKNOWN,
        # not "was not truncated" — a run dataset is never re-imported, so a
        # NULL here never self-corrects and callers must say so.
        truncated=_bool_or_none(row["truncated"]),
        ingest_cap=row["ingest_cap"],
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
    # Rule 14: user-chosen names must be redacted before persistence — the
    # session-dataset path has done this from the start; the run-scoped path
    # stored both display columns raw.
    from ..security.redaction import redact_text
    conn.execute(
        "INSERT INTO datasets "
        "(id, run_id, dataset_type, name, source_filename, stored_path, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?)",
        (dataset_id, run_id, dataset_type, redact_text(name) if name else name,
         redact_text(source_filename) if source_filename else source_filename,
         stored_path_rel, utcnow()),
    )
    conn.commit()
    return dataset_id


def mark_imported(
    conn: sqlite3.Connection,
    dataset_id: str,
    duckdb_path_rel: str,
    table_name: str,
    row_count: int,
    truncated: bool | None = None,
    ingest_cap: int | None = None,
) -> None:
    """Flag a run dataset imported.

    ``truncated``/``ingest_cap`` record that the import stopped at the row
    ceiling. The importing run states that in its own summary; persisting it is
    what lets a LATER question about the same dataset still say so — the same
    gap v0.80.0 closed for conversation uploads, which this path would otherwise
    reproduce the moment the agent can aggregate imported evidence."""
    conn.execute(
        "UPDATE datasets SET duckdb_path=?, table_name=?, row_count=?, "
        "truncated=?, ingest_cap=?, status='imported' WHERE id=?",
        (duckdb_path_rel, table_name, row_count,
         None if truncated is None else int(truncated), ingest_cap, dataset_id),
    )
    conn.commit()


def get(conn: sqlite3.Connection, dataset_id: str) -> DatasetOut | None:
    row = conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
    return _to_out(row) if row else None


def list_all(conn: sqlite3.Connection) -> list[DatasetOut]:
    rows = conn.execute("SELECT * FROM datasets ORDER BY created_at DESC, rowid DESC").fetchall()
    return [_to_out(r) for r in rows]


def list_for_run(conn: sqlite3.Connection, run_id: str) -> list[DatasetOut]:
    """Every dataset belonging to one run, oldest first.

    ``latest_for_run`` answers "the dataset this run imported"; this answers
    "everything this run left behind", which is what a later question about the
    imported evidence has to enumerate."""
    rows = conn.execute(
        "SELECT * FROM datasets WHERE run_id = ? ORDER BY rowid", (run_id,)
    ).fetchall()
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
