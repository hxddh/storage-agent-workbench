"""DuckDB connection helper for per-run analytical databases."""

from __future__ import annotations

from pathlib import Path

import duckdb


def connect(duckdb_path: str | Path) -> duckdb.DuckDBPyConnection:
    """Open (creating parent dirs) a DuckDB connection at ``duckdb_path``."""
    path = Path(duckdb_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(path))
