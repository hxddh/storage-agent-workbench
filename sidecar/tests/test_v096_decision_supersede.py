"""v0.96 — at most one pending Decision per (task, action_type)."""

import sqlite3

from app.migrations import apply_migrations
from app.task_runtime import store


def _db(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)",
        ("task", "t", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"),
    )
    store.ensure_task(conn, "task", "t", "g")
    conn.commit()
    return conn


def _open(conn, title, action="import_inventory"):
    return store.open_approval(conn, "task", None, action, title, "downloads bounded evidence",
                               {"tool": "import_evidence", "title": title})


def test_same_action_type_supersedes_prior_pending(tmp_path):
    conn = _db(tmp_path / "d.db")
    first = _open(conn, "one")
    second = _open(conn, "two")
    conn.commit()
    pending = store.list_decisions(conn, "task", status="pending")
    assert len(pending) == 1
    assert pending[0]["id"] == second["id"]
    assert pending[0]["proposal"]["title"] == "two"
    assert pending[0]["kind"] == "approval"
    old = store.get_decision(conn, first["id"])
    assert old["status"] == "superseded"


def test_different_action_types_stay_pending_side_by_side(tmp_path):
    conn = _db(tmp_path / "c.db")
    _open(conn, "inventory", "import_inventory")
    _open(conn, "logs", "import_access_log")
    pending = store.list_decisions(conn, "task", status="pending")
    assert len(pending) == 2


def test_task_scope_grant_is_remembered_per_action_type(tmp_path):
    conn = _db(tmp_path / "g.db")
    dec = _open(conn, "inventory")
    store.resolve_decision(conn, dec["id"], store.DECISION_APPROVED, scope="task")
    assert store.task_grant_exists(conn, "task", "import_inventory")
    assert not store.task_grant_exists(conn, "task", "import_access_log")
    once = _open(conn, "logs", "import_access_log")
    store.resolve_decision(conn, once["id"], store.DECISION_APPROVED)
    assert store.get_decision(conn, once["id"])["scope"] == "once"
    assert not store.task_grant_exists(conn, "task", "import_access_log")
