"""SQLite connection management and initialization.

A new connection is opened per request (cheap for SQLite) and closed when the
request finishes. WAL mode and a short busy timeout keep concurrent reads/writes
from the dev server well-behaved.
"""

from __future__ import annotations

import os
import sqlite3
from collections.abc import Iterator

from . import config
from .migrations import apply_migrations


def connect() -> sqlite3.Connection:
    """Open a configured connection to the app database."""
    path = config.db_path()
    config.ensure_secure_dir(path.parent)  # 0700 data dir (not umask-dependent)
    db_existed = path.exists()
    conn = sqlite3.connect(
        str(path),
        check_same_thread=False,
        # Busy timeout: with concurrent sessions each running on its own thread,
        # several connections may try to write at once. Wait for the write lock
        # instead of failing fast with "database is locked" (a 500). WAL allows
        # concurrent readers; writers still serialize, so a generous timeout keeps
        # brief overlaps from surfacing as errors.
        timeout=30.0,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA foreign_keys = ON")
    if not db_existed and os.name == "posix":
        # The DB holds object keys, derived rows and keyring:// refs — keep it
        # owner-only rather than the umask default (0644 world-readable).
        for suffix in ("", "-wal", "-shm"):
            try:
                os.chmod(f"{path}{suffix}", 0o600)
            except OSError:
                pass
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
