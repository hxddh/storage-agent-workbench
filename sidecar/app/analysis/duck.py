"""DuckDB connection helper for per-run analytical databases."""

from __future__ import annotations

from pathlib import Path

import duckdb


def connect(duckdb_path: str | Path, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    """Open (creating parent dirs) a DuckDB connection at ``duckdb_path``.

    ``read_only=True`` opens the existing DB read-only so a pure-read analysis
    (analyze/aggregate) can't collide with a concurrent import that DROPs/rebuilds
    the same table on another turn's worker thread. Falls back to a normal open if
    the file doesn't exist yet (the read-only mode can't create it)."""
    path = Path(duckdb_path)
    if read_only:
        if path.exists():
            return duckdb.connect(str(path), read_only=True)
        # No DB yet — nothing to read; open writable so the caller gets an empty DB
        # rather than a hard error.
    path.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(path))
