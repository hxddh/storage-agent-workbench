"""SQLite connection management and initialization.

A new connection is opened per request (cheap for SQLite) and closed when the
request finishes. WAL mode and a short busy timeout keep concurrent reads/writes
from the dev server well-behaved.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from collections.abc import Iterator

from . import config
from .migrations import apply_migrations

# Serializes write-then-commit sections that share ONE connection across threads
# (v0.55.0).
#
# `busy_timeout` below coordinates separate CONNECTIONS. It does nothing for two
# threads using the same one — and since v0.54.0 turned on parallel tool calls,
# that is exactly what happens: the Agents SDK dispatches each sync tool with
# `asyncio.to_thread`, and every tool in a turn shares the request's connection.
# A connection has ONE transaction, so two interleaved tool calls share it:
# thread A's `commit()` commits B's half-written work, and B's own `commit()`
# then raises "cannot commit - no transaction is active".
#
# That exception propagates out of the tool, so the agent sees a FAILED call for
# work that actually succeeded, and rule 17's "every tool call is recorded"
# quietly does not hold. Measured against the unguarded code over 120 forced-
# concurrent pairs: 2 of 240 calls died that way.
#
# One process-wide lock is the right grain: these sections are an INSERT plus a
# commit, held for microseconds, while the S3 call they bracket — the slow part,
# and the part parallelism exists to overlap — stays entirely outside it.
WRITE_LOCK = threading.RLock()


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
