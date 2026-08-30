"""WAL enablement retries SQLITE_BUSY instead of failing TestClient startup."""

from __future__ import annotations

import sqlite3

import pytest

from app import db


class _FakeConn:
    def __init__(self, fail_times: int, error: Exception | None = None) -> None:
        self.fail_times = fail_times
        self.error = error or sqlite3.OperationalError("database is locked")
        self.sqls: list[str] = []
        self.journal_calls = 0

    def execute(self, sql: str) -> None:
        self.sqls.append(sql)
        if sql.startswith("PRAGMA busy_timeout"):
            return
        if not sql.startswith("PRAGMA journal_mode"):
            raise AssertionError(f"unexpected SQL: {sql}")
        self.journal_calls += 1
        if self.journal_calls <= self.fail_times:
            raise self.error


def test_enable_wal_retries_locked_then_succeeds(monkeypatch):
    monkeypatch.setattr(db, "_WAL_LOCK_INITIAL_DELAY_S", 0)
    conn = _FakeConn(fail_times=2)
    db._enable_wal(conn)
    assert conn.sqls[0] == f"PRAGMA busy_timeout = {db._WAL_LOCK_BUSY_TIMEOUT_MS}"
    assert conn.journal_calls == 3
    assert db._WAL_LOCK_BUSY_TIMEOUT_MS * db._WAL_LOCK_RETRIES < db._CONNECT_BUSY_TIMEOUT_MS


def test_enable_wal_gives_up_after_retries(monkeypatch):
    monkeypatch.setattr(db, "_WAL_LOCK_INITIAL_DELAY_S", 0)
    monkeypatch.setattr(db, "_WAL_LOCK_RETRIES", 3)
    conn = _FakeConn(fail_times=99)
    with pytest.raises(sqlite3.OperationalError, match="database is locked"):
        db._enable_wal(conn)
    assert conn.journal_calls == 3


def test_enable_wal_does_not_retry_other_errors():
    conn = _FakeConn(fail_times=99, error=sqlite3.OperationalError("disk I/O error"))
    with pytest.raises(sqlite3.OperationalError, match="disk I/O error"):
        db._enable_wal(conn)
    assert conn.journal_calls == 1


def test_connect_restores_full_busy_timeout_after_wal(tmp_path, monkeypatch):
    monkeypatch.setenv("SAW_DB_PATH", str(tmp_path / "wal.db"))
    monkeypatch.setenv("SAW_DATA_DIR", str(tmp_path))
    conn = db.connect()
    try:
        timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert timeout == db._CONNECT_BUSY_TIMEOUT_MS
        assert str(mode).lower() == "wal"
    finally:
        conn.close()
