"""Tests for the SQLite migration runner and schema."""

import sqlite3

from app import config
from app.db import init_db
from app.migrations import MIGRATIONS, apply_migrations

REQUIRED_TABLES = {
    "model_providers",
    "cloud_providers",
    "runs",
    "messages",
    "tool_calls",
    "approval_events",
    "audit_logs",
    "datasets",
    "reports",
}


def _tables(db_path):
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    finally:
        conn.close()
    return {r[0] for r in rows}


def test_all_required_tables_created(tmp_path, monkeypatch):
    monkeypatch.setenv("SAW_DB_PATH", str(tmp_path / "mig.db"))
    init_db()
    assert REQUIRED_TABLES <= _tables(config.db_path())


def test_migrations_are_idempotent(tmp_path, monkeypatch):
    monkeypatch.setenv("SAW_DB_PATH", str(tmp_path / "mig2.db"))
    init_db()  # applies all migrations
    conn = sqlite3.connect(str(config.db_path()))
    try:
        applied = apply_migrations(conn)  # re-run: nothing new
        assert applied == 0
        version = conn.execute("SELECT max(version) FROM schema_migrations").fetchone()[0]
        assert version == len(MIGRATIONS)
    finally:
        conn.close()


def test_tool_calls_run_id_is_nullable(tmp_path, monkeypatch):
    monkeypatch.setenv("SAW_DB_PATH", str(tmp_path / "mig3.db"))
    init_db()
    conn = sqlite3.connect(str(config.db_path()))
    try:
        cols = {r[1]: r for r in conn.execute("PRAGMA table_info(tool_calls)")}
        # column index 3 in PRAGMA table_info is "notnull"
        assert cols["run_id"][3] == 0, "tool_calls.run_id must be nullable"
    finally:
        conn.close()
