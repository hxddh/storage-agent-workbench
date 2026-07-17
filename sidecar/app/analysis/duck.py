"""DuckDB connection helper for per-run analytical databases."""

from __future__ import annotations

from pathlib import Path

import duckdb


def _configure(con: duckdb.DuckDBPyConnection) -> duckdb.DuckDBPyConnection:
    # Pin the session timezone to UTC. Timestamps are normalized to naive-UTC at
    # ingest, but `current_timestamp` is TIMESTAMP WITH TIME ZONE, and DuckDB casts
    # a naive value against it using the session TimeZone — so an age `datediff`
    # (inventory `_AGE_CASE`) would land objects in the wrong age bucket by up to a
    # day when the sidecar runs outside UTC. UTC keeps every comparison consistent
    # with how the data was stored.
    con.execute("SET TimeZone='UTC'")
    return con


def connect(duckdb_path: str | Path, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    """Open (creating parent dirs) a DuckDB connection at ``duckdb_path``.

    ``read_only=True`` opens the existing DB read-only so a pure-read analysis
    (analyze/aggregate) can't collide with a concurrent import that DROPs/rebuilds
    the same table on another turn's worker thread. Falls back to a normal open if
    the file doesn't exist yet (the read-only mode can't create it)."""
    path = Path(duckdb_path)
    if read_only:
        if path.exists():
            try:
                return _configure(duckdb.connect(str(path), read_only=True))
            except duckdb.IOException as exc:
                # A concurrent import holds the write lock. Surface a friendly,
                # actionable message instead of the raw lock IOException.
                if "lock" in str(exc).lower():
                    raise ValueError(
                        "This dataset is busy (an import or rebuild is writing to it "
                        "right now). Retry in a moment, once the import finishes."
                    ) from exc
                raise
        # No DB yet — nothing to read; open writable so the caller gets an empty DB
        # rather than a hard error.
    path.parent.mkdir(parents=True, exist_ok=True)
    return _configure(duckdb.connect(str(path)))
