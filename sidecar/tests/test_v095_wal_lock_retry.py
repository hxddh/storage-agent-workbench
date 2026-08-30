"""WAL enablement retries SQLITE_BUSY instead of failing TestClient startup."""

from __future__ import annotations

import sqlite3

import pytest

from app import db


class _FakeConn:
    def __init__(self, fail_times: int, error: Exception | None = None) -> None:
        self.fail_times = fail_times
        self.error = error or sqlite3.OperationalError("database is locked")
        self.calls = 0

    def execute(self, sql: str) -> None:
        if not sql.startswith("PRAGMA journal_mode"):
            raise AssertionError(f"unexpected SQL: {sql}")
        self.calls += 1
        if self.calls <= self.fail_times:
            raise self.error


def test_enable_wal_retries_locked_then_succeeds(monkeypatch):
    monkeypatch.setattr(db, "_WAL_LOCK_INITIAL_DELAY_S", 0)
    conn = _FakeConn(fail_times=2)
    db._enable_wal(conn)
    assert conn.calls == 3


def test_enable_wal_gives_up_after_retries(monkeypatch):
    monkeypatch.setattr(db, "_WAL_LOCK_INITIAL_DELAY_S", 0)
    monkeypatch.setattr(db, "_WAL_LOCK_RETRIES", 3)
    conn = _FakeConn(fail_times=99)
    with pytest.raises(sqlite3.OperationalError, match="database is locked"):
        db._enable_wal(conn)
    assert conn.calls == 3


def test_enable_wal_does_not_retry_other_errors():
    conn = _FakeConn(fail_times=99, error=sqlite3.OperationalError("disk I/O error"))
    with pytest.raises(sqlite3.OperationalError, match="disk I/O error"):
        db._enable_wal(conn)
    assert conn.calls == 1
