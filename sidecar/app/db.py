"""SQLite connection management and initialization.

A new connection is opened per request (cheap for SQLite) and closed when the
request finishes. WAL mode and a short busy timeout keep concurrent reads/writes
from the dev server well-behaved.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator

from . import config
from .migrations import apply_migrations


def connect() -> sqlite3.Connection:
    """Open a configured connection to the app database."""
    path = config.db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(path),
        check_same_thread=False,
        timeout=5.0,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    """Create the database (if needed) and apply pending migrations."""
    conn = connect()
    try:
        apply_migrations(conn)
    finally:
        conn.close()


def get_conn() -> Iterator[sqlite3.Connection]:
    """FastAPI dependency that yields a request-scoped connection."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()
