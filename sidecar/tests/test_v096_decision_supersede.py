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


def _gated(action="plan_inventory_import", title="Import"):
    return {
        "action_type": action,
        "title": title,
        "requires_confirmation": True,
        "reason": "downloads bounded evidence",
    }


def test_same_action_type_supersedes_prior_pending(tmp_path):
    conn = _db(tmp_path / "d.db")
    first = store.open_decisions_from_proposals(conn, "task", None, None, [_gated(title="one")])
    second = store.open_decisions_from_proposals(conn, "task", None, None, [_gated(title="two")])
    conn.commit()
    pending = store.list_decisions(conn, "task", status="pending")
    assert len(pending) == 1
    assert pending[0]["id"] == second[0]["id"]
    assert pending[0]["proposal"]["title"] == "two"
    old = store.get_decision(conn, first[0]["id"])
    assert old["status"] == "superseded"


def test_duplicate_action_type_in_one_work_result_collapses(tmp_path):
    conn = _db(tmp_path / "c.db")
    opened = store.open_decisions_from_proposals(
        conn, "task", None, None,
        [_gated(title="first"), _gated(title="second")],
    )
    assert len(opened) == 1
    assert opened[0]["proposal"]["title"] == "second"
    pending = store.list_decisions(conn, "task", status="pending")
    assert len(pending) == 1
