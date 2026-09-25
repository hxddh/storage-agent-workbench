"""Product-level Agent Task tests.

v2.1 (native agent): nothing pauses a Task for a Decision any more. Decision
rows written by earlier versions stay readable as history, never block a task,
and restart recovery withdraws any left pending.
"""

import sqlite3
import time

from app import config
from app.task_runtime import recovery
from app.task_runtime import store as task_store


def _db():
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def _task(client, title: str):
    return client.post("/sessions", json={"title": title, "goal": "inspect storage"}).json()


def _legacy_pending_decision(conn, task_id) -> str:
    """A pending approval row exactly as v1.11–v2.0 wrote it."""
    conn.execute(
        "INSERT INTO task_decisions (id, task_id, execution_id, work_result_id, action_type, "
        "title, reason, proposal_json_sanitized, status, created_at, kind) "
        "VALUES ('dec-legacy', ?, NULL, NULL, 'import_access_log', 'Import 4 access log files', "
        "'bounded', '{\"impact\": {\"file_count\": 4}}', 'pending', datetime('now'), 'approval')",
        (task_id,))
    return "dec-legacy"


def test_a_legacy_pending_decision_never_blocks_the_task(client):
    task = _task(client, "Legacy approval row")
    with _db() as conn:
        task_store.ensure_task(conn, task["id"], task["title"], task["goal"])
        _legacy_pending_decision(conn, task["id"])
        assert task_store.derive_task_status(conn, task["id"]) == task_store.TASK_READY
        conn.commit()

    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert "requires_decision" not in projected
    state = client.get(f"/agent-tasks/{task['id']}/state").json()
    assert "pending_decisions" not in state
    assert state["status"] == "ready"
    # History stays readable.
    decisions = client.get(f"/agent-tasks/{task['id']}/decisions").json()["decisions"]
    assert [d["id"] for d in decisions] == ["dec-legacy"]


def test_there_is_no_route_that_resolves_a_decision(client):
    task = _task(client, "No resolve route")
    with _db() as conn:
        _legacy_pending_decision(conn, task["id"])
        conn.commit()
    r = client.post(f"/agent-tasks/{task['id']}/decisions/dec-legacy/resolve",
                    json={"resolution": "approved"})
    assert r.status_code in (404, 405)
    assert client.get("/settings/approval-policy").status_code == 404


def test_restart_recovery_withdraws_pending_decisions(client):
    task = _task(client, "Withdraw on restart")
    with _db() as conn:
        _legacy_pending_decision(conn, task["id"])
        conn.commit()
    recovery.reconcile_interrupted_executions()
    with _db() as conn:
        row = conn.execute("SELECT status, resolution_note FROM task_decisions "
                           "WHERE id = 'dec-legacy'").fetchone()
    assert row["status"] == "superseded"
    assert "v2.1" in row["resolution_note"]


def test_model_prose_never_becomes_a_decision(client):
    """A next step the model WRITES is just prose — nothing becomes a Decision.
    v2.2 — on the streamed path (fake endpoint)."""
    from tests.fake_model import FakeModel, text_turn
    task = _task(client, "Read-only follow-up suggestion")
    with FakeModel([text_turn("You should import the access logs next so I can confirm this.")]) as model:
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible", "base_url": model.base_url,
            "model": "fake-model", "api_key": "not-a-real-key"})
        execution = client.post(f"/agent-tasks/{task['id']}/executions",
                                json={"direction": "why 403?"}).json()["execution"]
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            row = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}").json()
            if row["status"] not in ("queued", "running"):
                break
            time.sleep(0.05)
    assert row["status"] == "completed"
    assert client.get(f"/agent-tasks/{task['id']}/decisions").json()["decisions"] == []
