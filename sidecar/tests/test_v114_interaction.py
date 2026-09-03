"""Waiting-state steer + editable queue (v1.14).

- A steer raised while an approval is open lands ON the waiting execution
  (its steer queue), not as a silently re-submitted follow-up.
- A queued Direction is editable until it leaves the queue.
"""

from __future__ import annotations

from app import db
from app.task_runtime import runtime, store


def _task(client, title="v114"):
    r = client.post("/sessions", json={"title": title, "goal": "v114"})
    assert r.status_code == 201, r.text
    return r.json()


def _store_task(task):
    conn = db.connect()
    try:
        store.ensure_task(conn, task["id"], task["title"], task.get("goal"))
        conn.commit()
    finally:
        conn.close()


def test_steer_lands_on_waiting_execution(client):
    task = _task(client)
    _store_task(task)
    conn = db.connect()
    try:
        execution = store.create_execution(conn, task["id"], "import it", "t-wait-steer")
        store.set_execution_status(conn, execution["id"], store.EXEC_WAITING)
        conn.commit()
        handle = runtime.LiveExecution(execution["id"], task["id"])
        runtime._live[execution["id"]] = handle
        try:
            out = runtime.steer(conn, task["id"], "hold on, check X first")
        finally:
            runtime._live.pop(execution["id"], None)
        assert out is not None and out["id"] == execution["id"]
        assert handle.steer_queue.drain() == ["hold on, check X first"]
        rows = store.list_events(conn, execution["id"])
        assert any(e["event_type"] == "steer.received" for e in rows)
    finally:
        conn.close()


def test_steer_with_nothing_live_returns_none(client):
    task = _task(client)
    _store_task(task)
    conn = db.connect()
    try:
        assert runtime.steer(conn, task["id"], "hello?") is None
    finally:
        conn.close()


def test_queued_direction_is_editable_until_it_runs(client):
    task = _task(client)
    _store_task(client)
    conn = db.connect()
    try:
        execution = store.create_execution(conn, task["id"], "first draft", "t-edit")
        conn.commit()
        edited = store.update_queued_direction(conn, execution["id"], "second draft")
        assert edited is not None and edited["direction"] == "second draft"
        assert edited["status"] == store.EXEC_QUEUED
        # Once running, the direction is frozen (steer instead).
        store.set_execution_status(conn, execution["id"], store.EXEC_RUNNING)
        conn.commit()
        assert store.update_queued_direction(conn, execution["id"], "too late") is None
    finally:
        conn.close()


def test_patch_queued_direction_route(client):
    # The row is created directly (no worker) so the queued state is exact —
    # no race with a claiming worker.
    task = _task(client)
    _store_task(task)
    conn = db.connect()
    try:
        execution = store.create_execution(conn, task["id"], "v1 text", "t-route-edit")
        conn.commit()
        exec_id = execution["id"]
    finally:
        conn.close()
    r = client.patch(f"/agent-tasks/{task['id']}/executions/{exec_id}",
                     json={"direction": "v2 text"})
    assert r.status_code == 200, r.text
    assert r.json()["execution"]["direction"] == "v2 text"
    conn = db.connect()
    try:
        store.set_execution_status(conn, exec_id, store.EXEC_RUNNING)
        conn.commit()
    finally:
        conn.close()
    r = client.patch(f"/agent-tasks/{task['id']}/executions/{exec_id}",
                     json={"direction": "v3 text"})
    assert r.status_code == 409
    r = client.patch(f"/agent-tasks/{task['id']}/executions/does-not-exist",
                     json={"direction": "x"})
    assert r.status_code == 404
