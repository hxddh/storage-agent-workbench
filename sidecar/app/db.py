"""SQLite connection management and initialization.

A new connection is opened per request (cheap for SQLite) and closed when the
request finishes. WAL mode and a short busy timeout keep concurrent reads/writes
from the dev server well-behaved.

A connection is NOT per thread, though: a turn's connection is shared by the tool
bodies the Agents SDK dispatches with `asyncio.to_thread`. `connect()` therefore
returns a `SerializedConnection`, which runs every statement under `DB_LOCK` and
drains it before releasing — see `DB_LOCK` for what goes wrong without it.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from collections.abc import Iterator

from . import config
from .migrations import apply_migrations

# Serializes EVERY statement on a connection that is shared across threads.
#
# `busy_timeout` below coordinates separate CONNECTIONS. It does nothing for two
# threads using the same one — and since v0.54.0 turned on parallel tool calls,
# that is exactly what happens: the Agents SDK dispatches each sync tool with
# `asyncio.to_thread`, and every tool in a turn shares the turn's connection.
#
# Two distinct hazards, and the lock answers both:
#
# 1. WRITE-THEN-COMMIT (v0.55.0). A connection has ONE transaction, so thread A's
#    `commit()` commits B's half-written work and B's own `commit()` then raises
#    "cannot commit - no transaction is active". That is why callers still wrap
#    an INSERT and its commit in an explicit `with db.DB_LOCK:` block — the lock
#    taken per statement below cannot know two statements belong together.
#
# 2. ANY TWO CONCURRENT STATEMENTS (this release). `sqlite3.threadsafety` is 3,
#    which says the SQLite *library* is serialized — it does not make CPython's
#    per-connection bookkeeping safe. Two threads stepping statements on one
#    connection can hand back a TORN row: a `sqlite3.Row` whose description has
#    more columns than the row has values, so `row["id"]` raises
#    `IndexError: tuple index out of range`. Reproduced on CPython 3.12 (the
#    version CI runs) with a plain read/write pair on one in-memory connection —
#    1 tear in 6000 rounds — and with two pure READS, no writer at all, 3 tears
#    in 6000. Serializing writes alone therefore never closed it. CPython 3.11
#    does not tear in the same 6000 rounds, which is why this only ever showed
#    up in CI.
#
#    The agent felt it as a dead tool call: the Agents SDK catches whatever the
#    tool body raises and hands the model
#    "An error occurred while running the tool. Please try again. Error: tuple
#    index out of range" — a failure for work that had actually succeeded, with
#    the traceback discarded.
#
# One process-wide lock is the right grain: a statement against a local SQLite
# file is microseconds, and the slow part these calls bracket — the S3 request,
# the part parallelism exists to overlap — stays entirely outside it.
DB_LOCK = threading.RLock()


class _Result:
    """One finished statement: rows already fetched, counters already read.

    A `sqlite3.Cursor` fetches lazily, so returning one would let the caller step
    the statement *after* `DB_LOCK` was released — exactly the race the lock
    exists to close. Draining inside the lock makes "run the statement" atomic
    from the caller's point of view, and this shim then serves the rows with the
    cursor's own semantics (`fetchone`/`fetchmany`/`fetchall` consume).
    """

    __slots__ = ("description", "lastrowid", "rowcount", "_rows", "_i")

    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.description = cur.description
        self.lastrowid = cur.lastrowid
        self.rowcount = cur.rowcount
        # `description` is None for statements that return no result set.
        self._rows: list = cur.fetchall() if cur.description is not None else []
        self._i = 0

    def fetchone(self):
        if self._i >= len(self._rows):
            return None
        self._i += 1
        return self._rows[self._i - 1]

    def fetchmany(self, size: int | None = None):
        n = len(self._rows) - self._i if size is None else max(int(size), 0)
        out = self._rows[self._i:self._i + n]
        self._i += len(out)
        return out

    def fetchall(self):
        out = self._rows[self._i:]
        self._i = len(self._rows)
        return out

    def __iter__(self):
        return iter(self.fetchall())

    def close(self) -> None:  # cursor parity; the statement is already finished
        return None


class SerializedConnection:
    """A `sqlite3.Connection` that is safe to use from several threads at once.

    Every statement runs under `DB_LOCK` and is drained before the lock is
    released (see `_Result`). Attribute access, including `row_factory`, passes
    straight through, so this is a drop-in for the real connection everywhere the
    app uses one.

    Statements must go through `execute` / `executemany` / `executescript`. A
    cursor obtained from `.cursor()` would step outside the lock, so nothing in
    the app takes one.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.__dict__["_conn"] = conn

    # -- passthrough ---------------------------------------------------------
    def __getattr__(self, name: str):
        return getattr(self.__dict__["_conn"], name)

    def __setattr__(self, name: str, value) -> None:
        setattr(self.__dict__["_conn"], name, value)

    # -- serialized statements ----------------------------------------------
    def execute(self, sql: str, parameters=()) -> _Result:
        with DB_LOCK:
            return _Result(self.__dict__["_conn"].execute(sql, parameters))

    def executemany(self, sql: str, parameters) -> _Result:
        with DB_LOCK:
            return _Result(self.__dict__["_conn"].executemany(sql, parameters))

    def executescript(self, script: str) -> _Result:
        with DB_LOCK:
            return _Result(self.__dict__["_conn"].executescript(script))

    def commit(self) -> None:
        with DB_LOCK:
            self.__dict__["_conn"].commit()

    def rollback(self) -> None:
        with DB_LOCK:
            self.__dict__["_conn"].rollback()

    def close(self) -> None:
        with DB_LOCK:
            self.__dict__["_conn"].close()

    def __enter__(self):
        # `with conn:` is a transaction, so hold the lock for the whole body —
        # otherwise another thread's statement lands inside this transaction.
        DB_LOCK.acquire()
        return self

    def __exit__(self, *exc_info) -> bool:
        try:
            return bool(self.__dict__["_conn"].__exit__(*exc_info))
        finally:
            DB_LOCK.release()


def serialized(conn: sqlite3.Connection) -> SerializedConnection:
    """Wrap a connection so concurrent threads cannot tear each other's rows.

    Applied by `connect()`, so every connection the app opens is safe. Tests that
    build their own in-memory connection and then hand it to code that runs on
    several threads (the agent's tool bodies) must wrap it the same way.
    """
    if isinstance(conn, SerializedConnection):
        return conn
    return SerializedConnection(conn)


def connect() -> SerializedConnection:
    """Open a configured connection to the app database.

    Returned already serialized: a turn's connection is shared by the tool
    bodies the SDK dispatches with `asyncio.to_thread`, and an unguarded one
    tears rows between them (see `DB_LOCK`)."""
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
    return serialized(conn)


def init_db() -> None:
    """Create the database (if needed) and apply pending migrations."""
    conn = connect()
    try:
        apply_migrations(conn)
    finally:
        conn.close()


def get_conn() -> Iterator[SerializedConnection]:
    """FastAPI dependency that yields a request-scoped connection."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()
