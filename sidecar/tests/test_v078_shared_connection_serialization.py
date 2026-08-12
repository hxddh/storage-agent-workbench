"""v0.78.0 — the tool call that died on a row another thread was reading.

`test_many_concurrent_pairs_lose_no_audit_or_call_row` had been failing on CI a
few times a release, always the same way and never locally:

    AssertionError: 1 call(s) returned an error, first: 'An error occurred while
    running the tool. Please try again. Error: tuple index out of range'

The message is the Agents SDK's `default_tool_error_function`, which stringifies
whatever the tool body raised and drops the traceback — so the failure arrived
with no stack, and three earlier candidate mechanisms were measured and
disproven. Handing the test a `failure_error_function` that keeps the traceback
named the throw site on the first reproduction:

    app/repositories/cloud_providers.py:34 in _row_to_out
        id=row["id"],
    IndexError: tuple index out of range

**A torn row.** Two tool bodies share the turn's one connection — the SDK
dispatches each sync tool with `asyncio.to_thread` — and two threads stepping
statements on a single `sqlite3.Connection` can hand back a `sqlite3.Row` whose
description carries more columns than the row has values. `row["id"]` then walks
off the end of the value tuple. `sqlite3.threadsafety` is 3, but that only says
the SQLite *library* is serialized; CPython's per-connection bookkeeping is not.

It reproduces on a bare connection with no app code involved, and only on the
Pythons newer than the developer machines, which is the whole reason it lived in
CI. Measured over 6000 forced-concurrent rounds on one in-memory connection:

| | 3.11 | 3.12 (CI) | 3.13 |
| --- | --- | --- | --- |
| write under the lock, read unguarded (the shipped code) | 0 | 1 | 2 |
| **two pure reads, no writer at all** | 0 | **3** | **10** |

The second row is the important one: the old `WRITE_LOCK` guarded writes, so no
amount of write locking could ever have closed this. Every statement has to be
serialized, and it has to stay serialized until its rows are fetched — which is
what `db.serialized` now does, and what `db.connect()` now returns.

**And the lock has to be PER CONNECTION.** The first cut of this fix used one
process-wide lock, which deadlocks two writing connections: A's INSERT opens a
SQLite write transaction and releases the lock, B's INSERT takes the lock and
parks inside `sqlite3_step` waiting for A's transaction, and A's `commit()` —
the only thing that would end it — cannot get the lock back. Measured on that
version with an 8s `busy_timeout`: an 8.0s stall, B raising `database is
locked`, and every other statement in the process queued behind it. In
production the wait is 30s. Caught in review, before release.

Which tests here detect a bug, stated honestly, because it is not uniform:

- `test_concurrent_readers_never_see_a_torn_row` and
  `test_the_app_opens_serialized_connections` FAIL against the unguarded code
  (verified by reverting `db.serialized` to a passthrough);
- `test_two_writing_connections_do_not_deadlock_each_other` FAILS against the
  process-wide version (verified by pointing the wrapper back at one shared
  lock);
- the rest pin the wrapper's drop-in contract, including the draining that a
  bare `with lock: execute(...)` would have missed. They pass either way by
  design and are non-regression guards, not detectors.

The write-racing-a-read shape that CI actually hit is covered end-to-end, at the
agent tool surface, by
`test_v055_tool_disclosure.py::test_many_concurrent_pairs_lose_no_audit_or_call_row`.
"""

from __future__ import annotations

import sqlite3
import threading
import time

import pytest

from app import db, migrations

_COLUMNS = ("id", "a", "b", "c", "d")


def _seed(conn):
    conn.execute("CREATE TABLE t (id TEXT, a TEXT, b TEXT, c TEXT, d TEXT)")
    for i in range(5):
        conn.execute("INSERT INTO t VALUES (?,?,?,?,?)", (str(i), "a", "b", "c", "d"))
    conn.commit()


@pytest.fixture()
def conn():
    c = db.serialized(sqlite3.connect(":memory:", check_same_thread=False))
    c.row_factory = sqlite3.Row
    _seed(c)
    return c


# --- the invariant -----------------------------------------------------------


def test_concurrent_readers_never_see_a_torn_row(conn):
    """The probabilistic half, at the volume that actually detected the bug.

    2000 rounds of two threads reading the same table at once. On an unguarded
    connection this is where `row["id"]` raises `IndexError: tuple index out of
    range` (3 in 6000 rounds on 3.12, 10 on 3.13). A tear can also surface as a
    row that is merely SHORT rather than as a raised error, so the widths are
    checked too rather than trusting "nothing raised".
    """
    rounds = 2000
    errors: list[BaseException] = []
    widths: set[int] = set()
    barrier = threading.Barrier(2, timeout=10)

    def reader():
        for _ in range(rounds):
            try:
                barrier.wait()
            except threading.BrokenBarrierError:  # pragma: no cover — timing guard
                pass
            try:
                for row in conn.execute("SELECT * FROM t ORDER BY id").fetchall():
                    widths.add(len(tuple(row)))
                    for column in _COLUMNS:
                        _ = row[column]
            except BaseException as exc:  # noqa: BLE001 — the tear is the finding
                errors.append(exc)

    threads = [threading.Thread(target=reader) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(120)
    assert not errors, f"{len(errors)} torn read(s), first: {errors[0]!r}"
    assert widths == {len(_COLUMNS)}, f"a row came back short: widths={sorted(widths)}"


def test_two_writing_connections_do_not_deadlock_each_other(tmp_path, monkeypatch):
    """The hazard a process-wide statement lock creates, and this one must not.

    Two connections — which is the normal shape, not a corner case: every request
    opens one and a turn's worker owns another for its whole lifetime. A writes
    and holds its transaction; B writes at the same time and blocks inside SQLite
    waiting for A. If B's wait also held the lock A needs to commit, neither
    moves until B's `busy_timeout` expires.

    `busy_timeout` is dropped to 2s here so a regression costs the suite two
    seconds instead of the production thirty.
    """
    monkeypatch.setattr(db.config, "db_path", lambda: tmp_path / "app.sqlite3")
    a, b = db.connect(), db.connect()
    try:
        migrations.apply_migrations(a)
        for c in (a, b):
            c.execute("PRAGMA busy_timeout = 2000")
        a_wrote, b_started = threading.Event(), threading.Event()
        errors: list[BaseException] = []

        def rows(who):
            return (f"s-{who}", who, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")

        def writer_a():
            try:
                a.execute("INSERT INTO sessions (id, title, created_at, updated_at) "
                          "VALUES (?,?,?,?)", rows("a"))
                a_wrote.set()
                b_started.wait(5)
                time.sleep(0.2)  # let B get all the way into sqlite3_step
                a.commit()
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        def writer_b():
            try:
                a_wrote.wait(5)
                b_started.set()
                b.execute("INSERT INTO sessions (id, title, created_at, updated_at) "
                          "VALUES (?,?,?,?)", rows("b"))
                b.commit()
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=writer_a), threading.Thread(target=writer_b)]
        started = time.monotonic()
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        elapsed = time.monotonic() - started

        assert not errors, f"a writer failed: {errors[0]!r}"
        # Under the deadlock this is the full busy_timeout; without it, instant.
        assert elapsed < 1.5, f"the two writers stalled on each other for {elapsed:.1f}s"
        assert a.execute("SELECT count(*) FROM sessions").fetchone()[0] == 2
    finally:
        a.close()
        b.close()


# --- the wrapper stays a drop-in ---------------------------------------------


def test_the_app_opens_serialized_connections(tmp_path, monkeypatch):
    """The fix has to be on the connection the app actually hands to a turn, not
    only on one tests construct."""
    monkeypatch.setattr(db.config, "db_path", lambda: tmp_path / "app.sqlite3")
    conn = db.connect()
    try:
        assert isinstance(conn, db.SerializedConnection)
    finally:
        conn.close()


def test_execute_hands_back_rows_not_a_lazy_cursor(conn):
    """A contract guard, not a bug detector.

    Draining inside the lock is the half of the fix the lock alone does not buy:
    a `sqlite3.Cursor` steps its rows lazily, so a caller could still be fetching
    after the lock was released. That window cannot be observed from outside
    without racing it, so pin the shape instead — `execute` returns a finished
    result whose rows outlive a later statement on the same connection.
    """
    cur = conn.execute("SELECT * FROM t ORDER BY id")
    assert not isinstance(cur, sqlite3.Cursor)
    conn.execute("DELETE FROM t")
    assert [r["id"] for r in cur.fetchall()] == ["0", "1", "2", "3", "4"]
    conn.rollback()


def test_serialized_is_idempotent(conn):
    assert db.serialized(conn) is conn


def test_transaction_refuses_a_connection_it_cannot_lock():
    """v0.79.0 — the fallback that v0.78.0 shipped was a landmine.

    `db.transaction()` used to hand back one process-wide lock for a bare
    `sqlite3.Connection`. Held across a write section, that is precisely the
    shape that deadlocks two writing connections — so the construct built to
    prevent the hazard would have quietly reintroduced it. Nothing in `app/` can
    reach it (`connect()` is the only place a connection is opened, and it always
    wraps), which is exactly why it would have gone unnoticed until something
    new did. Refusing is the honest answer: the caller is told, and told how.
    """
    raw = sqlite3.connect(":memory:")
    try:
        with pytest.raises(TypeError, match="serialized connection"):
            db.transaction(raw)
        # And the wrapped form it points you at works.
        wrapped = db.serialized(raw)
        with db.transaction(wrapped):
            wrapped.execute("SELECT 1")
    finally:
        raw.close()


def test_transaction_hands_each_connection_its_own_lock():
    """Two connections must not share a lock — see the deadlock test above."""
    a = db.serialized(sqlite3.connect(":memory:"))
    b = db.serialized(sqlite3.connect(":memory:"))
    try:
        assert db.transaction(a) is not db.transaction(b)
        assert db.transaction(a) is db.transaction(a)  # stable per connection
    finally:
        a.close()
        b.close()


def test_the_wrapper_keeps_the_cursor_contract(conn):
    """`execute` returns rows already fetched, so the shim has to behave like the
    cursor the 197 call sites in `app/` still expect."""
    cur = conn.execute("SELECT * FROM t ORDER BY id")
    assert [d[0] for d in cur.description] == list(_COLUMNS)
    first = cur.fetchone()
    assert first["id"] == "0"
    assert [r["id"] for r in cur.fetchmany(2)] == ["1", "2"]
    assert [r["id"] for r in cur.fetchall()] == ["3", "4"]
    assert cur.fetchone() is None
    assert list(conn.execute("SELECT id FROM t ORDER BY id")) != []
    # Row factory, counters and non-SELECT statements all pass through unchanged.
    assert isinstance(conn.execute("SELECT * FROM t").fetchone(), sqlite3.Row)
    written = conn.execute("INSERT INTO t VALUES ('z','a','b','c','d')")
    assert written.description is None and written.fetchall() == []
    assert conn.execute("UPDATE t SET a = 'q' WHERE id = 'z'").rowcount == 1
    conn.commit()


def test_executescript_and_transactions_pass_through(conn):
    conn.executescript("CREATE TABLE s (x INTEGER); INSERT INTO s VALUES (7);")
    assert conn.execute("SELECT x FROM s").fetchone()["x"] == 7
    with conn:
        conn.execute("INSERT INTO s VALUES (8)")
    assert [r["x"] for r in conn.execute("SELECT x FROM s ORDER BY x")] == [7, 8]
