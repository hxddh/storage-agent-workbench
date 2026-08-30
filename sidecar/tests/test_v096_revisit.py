"""v0.96 — revisit scheduling never auto-crosses a Decision."""

import sqlite3

from app.migrations import apply_migrations
from app.task_runtime import revisit as revisit_mod
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


def test_due_catchup_uses_submit_kind_revisit(tmp_path, monkeypatch):
    conn = _db(tmp_path / "r.db")
    revisit_mod.set_schedule(conn, "task", interval_days=7, enabled=True)
    conn.execute(
        "UPDATE task_revisit_schedules SET next_due_at = ? WHERE task_id = ?",
        ("2020-01-01T00:00:00Z", "task"),
    )
    conn.commit()
    conn.close()

    submitted = []

    def fake_submit(conn, task_id, direction, turn_id=None, *, kind="direction", **kwargs):
        submitted.append({"task_id": task_id, "kind": kind, "direction": direction})
        return {"id": "exec", "kind": kind}

    monkeypatch.setattr("app.task_runtime.runtime.submit", fake_submit)
    monkeypatch.setattr("app.db.connect", lambda: sqlite3.connect(tmp_path / "r.db"))
    # The tick() connection needs row_factory for dict(row)
    real_connect = sqlite3.connect

    def connect_row():
        c = real_connect(tmp_path / "r.db")
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        return c

    monkeypatch.setattr("app.db.connect", connect_row)
    n = revisit_mod.tick(now="2026-08-30T00:00:00Z")
    assert n == 1
    assert submitted[0]["kind"] == "revisit"
    assert "[catch-up]" in submitted[0]["direction"]
    assert "never apply" in submitted[0]["direction"].lower() or "Decision" in submitted[0]["direction"]


def test_disabled_schedule_is_not_due(tmp_path):
    conn = _db(tmp_path / "d.db")
    revisit_mod.set_schedule(conn, "task", interval_days=1, enabled=False)
    assert revisit_mod.due_rows(conn, now="2099-01-01T00:00:00Z") == []


def test_tick_does_not_resolve_pending_decisions(tmp_path, monkeypatch):
    conn = _db(tmp_path / "p.db")
    store.open_decisions_from_proposals(conn, "task", None, None, [{
        "action_type": "plan_inventory_import",
        "title": "Import inventory",
        "requires_confirmation": True,
    }])
    revisit_mod.set_schedule(conn, "task", interval_days=1, enabled=True)
    conn.execute(
        "UPDATE task_revisit_schedules SET next_due_at = ? WHERE task_id = ?",
        ("2020-01-01T00:00:00Z", "task"),
    )
    conn.commit()
    path = tmp_path / "p.db"
    conn.close()

    def fake_submit(conn, task_id, direction, turn_id=None, *, kind="direction", **kwargs):
        pending = store.list_decisions(conn, task_id, status="pending")
        assert pending, "revisit must not auto-resolve the pending Decision"
        assert all(d["status"] == "pending" for d in pending)
        return {"id": "exec", "kind": kind}

    monkeypatch.setattr("app.task_runtime.runtime.submit", fake_submit)
    monkeypatch.setattr("app.db.connect", lambda: _row(path))
    revisit_mod.tick(now="2026-08-30T00:00:00Z")
    conn = _row(path)
    still = store.list_decisions(conn, "task", status="pending")
    assert len(still) == 1


def test_concurrent_ticks_submit_one_revisit(tmp_path, monkeypatch):
    import threading
    path = tmp_path / "c.db"
    conn = _db(path)
    revisit_mod.set_schedule(conn, "task", interval_days=7, enabled=True)
    conn.execute(
        "UPDATE task_revisit_schedules SET next_due_at = ? WHERE task_id = ?",
        ("2020-01-01T00:00:00Z", "task"),
    )
    conn.commit()
    conn.close()

    submitted: list[str] = []
    lock = threading.Lock()

    def fake_submit(conn, task_id, direction, turn_id=None, *, kind="direction", **kwargs):
        with lock:
            submitted.append(kind)
        return {"id": "exec", "kind": kind}

    monkeypatch.setattr("app.task_runtime.runtime.submit", fake_submit)
    monkeypatch.setattr("app.db.connect", lambda: _row(path))

    counts: list[int] = []

    def run():
        counts.append(revisit_mod.tick(now="2026-08-30T00:00:00Z"))

    threads = [threading.Thread(target=run) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sum(counts) == 1
    assert submitted == ["revisit"]


def test_unavailable_agent_rolls_back_claim_but_keeps_catchup_note(tmp_path, monkeypatch):
    from app.agent_runtime.agent_service import AgentUnavailable
    path = tmp_path / "u.db"
    conn = _db(path)
    revisit_mod.set_schedule(conn, "task", interval_days=7, enabled=True)
    conn.execute(
        "UPDATE task_revisit_schedules SET next_due_at = ?, last_catchup_note = ? "
        "WHERE task_id = ?",
        ("2020-01-01T00:00:00Z", "catch-up", "task"),
    )
    conn.commit()
    conn.close()

    def boom(conn, task_id, direction, turn_id=None, *, kind="direction", **kwargs):
        raise AgentUnavailable("No model provider configured.")

    monkeypatch.setattr("app.task_runtime.runtime.submit", boom)
    monkeypatch.setattr("app.db.connect", lambda: _row(path))
    assert revisit_mod.tick(now="2026-08-30T00:00:00Z") == 0
    row = dict(_row(path).execute(
        "SELECT next_due_at, last_catchup_note FROM task_revisit_schedules WHERE task_id = ?",
        ("task",),
    ).fetchone())
    assert row["next_due_at"] == "2020-01-01T00:00:00Z"
    assert row["last_catchup_note"] == "catch-up"


def _row(path):
    c = sqlite3.connect(path, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    c.execute("PRAGMA busy_timeout = 5000")
    return c
