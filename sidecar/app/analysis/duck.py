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
    # Defense-in-depth memory ceiling: the analysis runs inside the desktop app's
    # sidecar, so an unbounded DuckDB query (a future path using read_csv_auto on a
    # crafted file, a huge aggregate) must not be able to exhaust host RAM and take
    # the app down. Bounded threads likewise keep a background analysis from
    # starving the UI. Both are best-effort — ignored if the build rejects them.
    for pragma in ("SET memory_limit='2GB'", "SET threads=4"):
        try:
            con.execute(pragma)
        except duckdb.Error:
            pass
    return con


def connect(duckdb_path: str | Path, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    """Open (creating parent dirs) a DuckDB connection at ``duckdb_path``.

    ``read_only=True`` opens the existing DB read-only so a pure-read analysis
    (analyze/aggregate) can't collide with a concurrent import that DROPs/rebuilds
    the same table on another turn's worker thread. A missing file is a clean
    "dataset not imported" error — a read must not leave a stray empty ``.duckdb``
    behind (it used to fall back to a WRITABLE open that created one).

    Lock contention is translated to a friendly, retryable ``ValueError`` on BOTH
    open modes: a reader blocked by a writer AND a writer (import) blocked by a
    long analyze on another worker thread previously surfaced the raw
    ``IOException`` from the writer side."""
    path = Path(duckdb_path)
    if read_only:
        if not path.exists():
            raise ValueError(
                "This dataset has no analytical database yet (nothing was imported, "
                "or the import did not complete). Import the data first."
            )
        try:
            return _configure(duckdb.connect(str(path), read_only=True))
        except duckdb.IOException as exc:
            if "lock" in str(exc).lower():
                raise ValueError(
                    "This dataset is busy (an import or rebuild is writing to it "
                    "right now). Retry in a moment, once the import finishes."
                ) from exc
            raise
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        return _configure(duckdb.connect(str(path)))
    except duckdb.IOException as exc:
        if "lock" in str(exc).lower():
            raise ValueError(
                "This dataset is busy (another analysis or import holds it right "
                "now). Retry in a moment."
            ) from exc
        raise
