"""The v5 schema: one migration, append-only from here, idempotent."""

import sqlite3

from app import config
from app.migrations import HEAD, MIGRATIONS, apply_migrations

REQUIRED_TABLES = {
    "settings", "model_providers", "cloud_providers", "tasks", "turns", "items", "artifacts", "datasets",
    "estate_buckets", "issues", "issue_events", "watch_schedules", "audit", "spans",
}


def _tables(conn):
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def test_all_required_tables_created():
    conn = sqlite3.connect(str(config.db_path()))
    try:
        assert REQUIRED_TABLES <= _tables(conn)
        assert "sessions" not in _tables(conn) and "runs" not in _tables(conn)
    finally:
        conn.close()


def test_migrations_are_idempotent():
    conn = sqlite3.connect(str(config.db_path()))
    try:
        assert apply_migrations(conn) == 0
        assert conn.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] == HEAD == len(MIGRATIONS)
    finally:
        conn.close()


def test_items_seq_is_global_and_monotonic(conn):
    from app.core import store
    a = store.create_task(conn, "a")
    b = store.create_task(conn, "b")
    ta = store.create_turn(conn, a["id"], "one")
    tb = store.create_turn(conn, b["id"], "two")
    s1 = store.append_item(conn, a["id"], ta["id"], "user_message", {"text": "one"})["seq"]
    s2 = store.append_item(conn, b["id"], tb["id"], "user_message", {"text": "two"})["seq"]
    s3 = store.append_item(conn, a["id"], ta["id"], "notice", {"event": "started"})["seq"]
    assert s1 < s2 < s3
    assert [i["seq"] for i in store.items_after(conn, a["id"], 0)] == [s1, s3]
