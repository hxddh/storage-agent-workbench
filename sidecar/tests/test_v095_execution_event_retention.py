"""v0.95 — bounded execution_events retention.

Only terminal executions are pruned; truncation always leaves an explicit
marker event; active/waiting logs are untouched; dual caps (days + per-
execution count); either cap can be disabled with 0.
"""

from __future__ import annotations

import sqlite3

from app.migrations import apply_migrations
from app.task_runtime import store


def _fresh_db(path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    return conn


def _exec(conn, task_id: str, status: str, exec_id: str | None = None) -> str:
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (task_id, "t", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"),
    )
    store.ensure_task(conn, task_id, "t", "g")
    row = store.create_execution(conn, task_id, "direction", turn_id=exec_id or None)
    store.set_execution_status(conn, row["id"], status)
    conn.commit()
    return row["id"]


def _events(conn, exec_id: str, n: int, created_at: str, task_id: str = "task") -> None:
    for i in range(n):
        conn.execute(
            "INSERT INTO execution_events (execution_id, task_id, event_type, "
            "payload_json_sanitized, created_at) VALUES (?, ?, ?, ?, ?)",
            (exec_id, task_id, f"tool.completed", "{}", created_at),
        )
    conn.commit()


def test_does_not_prune_running_or_waiting(tmp_path, monkeypatch):
    from app import data_maintenance
    conn = _fresh_db(tmp_path / "live.db")
    running = _exec(conn, "t-run", store.EXEC_RUNNING)
    waiting = _exec(conn, "t-wait", store.EXEC_WAITING)
    done = _exec(conn, "t-done", store.EXEC_COMPLETED)
    _events(conn, running, 5, "2000-01-01T00:00:00Z", "t-run")
    _events(conn, waiting, 5, "2000-01-01T00:00:00Z", "t-wait")
    _events(conn, done, 5, "2000-01-01T00:00:00Z", "t-done")
    monkeypatch.setenv("STORAGE_AGENT_EXECUTION_EVENT_RETENTION_DAYS", "1")
    monkeypatch.setenv("STORAGE_AGENT_EXECUTION_EVENT_MAX_PER_EXECUTION", "0")
    data_maintenance.prune_execution_events(conn)
    assert conn.execute("SELECT count(*) FROM execution_events WHERE execution_id=?",
                        (running,)).fetchone()[0] == 5
    assert conn.execute("SELECT count(*) FROM execution_events WHERE execution_id=?",
                        (waiting,)).fetchone()[0] == 5
    leftover = list(conn.execute(
        "SELECT event_type FROM execution_events WHERE execution_id=? ORDER BY seq",
        (done,)))
    assert leftover[0]["event_type"] == "execution.events_truncated"
    assert all(r["event_type"] != "tool.completed" or i == 0
               for i, r in enumerate(leftover))
    # All five old events were in the drop set; the oldest became the marker
    # and the other four were deleted.
    assert len(leftover) == 1


def test_count_cap_rewrites_oldest_as_explicit_marker(tmp_path, monkeypatch):
    from app import data_maintenance
    conn = _fresh_db(tmp_path / "cap.db")
    done = _exec(conn, "t-cap", store.EXEC_COMPLETED)
    _events(conn, done, 8, "2026-08-01T00:00:00Z", "t-cap")
    monkeypatch.setenv("STORAGE_AGENT_EXECUTION_EVENT_RETENTION_DAYS", "0")
    monkeypatch.setenv("STORAGE_AGENT_EXECUTION_EVENT_MAX_PER_EXECUTION", "3")
    deleted = data_maintenance.prune_execution_events(conn)
    assert deleted == 4  # 5 dropped, 1 rewritten as marker, 4 deleted
    rows = list(conn.execute(
        "SELECT seq, event_type, payload_json_sanitized FROM execution_events "
        "WHERE execution_id=? ORDER BY seq", (done,)))
    assert rows[0]["event_type"] == "execution.events_truncated"
    assert "removed_count" in rows[0]["payload_json_sanitized"]
    assert "not silent" in rows[0]["payload_json_sanitized"]
    assert [r["event_type"] for r in rows[1:]] == ["tool.completed"] * 3


def test_disabled_caps_keep_everything(tmp_path, monkeypatch):
    from app import data_maintenance
    conn = _fresh_db(tmp_path / "keep.db")
    done = _exec(conn, "t-keep", store.EXEC_INTERRUPTED)
    _events(conn, done, 4, "2000-01-01T00:00:00Z", "t-keep")
    monkeypatch.setenv("STORAGE_AGENT_EXECUTION_EVENT_RETENTION_DAYS", "0")
    monkeypatch.setenv("STORAGE_AGENT_EXECUTION_EVENT_MAX_PER_EXECUTION", "0")
    assert data_maintenance.prune_execution_events(conn) == 0
    assert conn.execute("SELECT count(*) FROM execution_events").fetchone()[0] == 4


def test_startup_maintenance_includes_event_prune(tmp_path, monkeypatch):
    from app import data_maintenance
    monkeypatch.setenv("SAW_DB_PATH", str(tmp_path / "boot.db"))
    conn = _fresh_db(tmp_path / "boot.db")
    conn.close()
    monkeypatch.setenv("STORAGE_AGENT_EXECUTION_EVENT_RETENTION_DAYS", "30")
    result = data_maintenance.run_startup_maintenance()
    assert "execution_events_pruned" in result
