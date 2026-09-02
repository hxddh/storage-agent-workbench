"""Product-level Agent Task tests.

The task command center cannot depend on the browser's live run store: a
Decision is a first-class durable row (v0.94), so it must still be visible
after reload/restart, and a later Agent Work Result must supersede older
pending decisions — durably, not by re-parsing the latest message.
"""

import sqlite3

from app import config
from app.task_runtime import store as task_store


def _db():
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def _task(client, title: str):
    return client.post("/sessions", json={"title": title, "goal": "inspect storage"}).json()


def _gated_proposal(title="Import access-log evidence"):
    return {
        "action_type": "plan_access_log_import",
        "title": title,
        "reason": "This operation downloads bounded evidence files.",
        "requires_confirmation": True,
        "confidence": "high",
        "source_run_ids": [],
    }


def _open_approval(conn, task_id):
    return task_store.open_approval(
        conn, task_id, None, "import_access_log", "Import 4 access log files", "bounded",
        {"tool": "import_evidence", "impact": {"gate": "cloud_download", "file_count": 4,
                                               "total_bytes": 2048, "bucket": "acme-logs"}})


def test_agent_task_projection_persists_current_decision(client):
    task = _task(client, "Review bounded evidence import")
    with _db() as conn:
        _open_approval(conn, task["id"])
        conn.commit()

    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is True

    # The decision is a durable object, listable in its own right, with the
    # impact the tool projected when it raised it.
    decisions = client.get(f"/agent-tasks/{task['id']}/decisions").json()["decisions"]
    assert len(decisions) == 1
    assert decisions[0]["status"] == "pending"
    assert decisions[0]["action_type"] == "import_access_log"
    assert decisions[0]["kind"] == "approval"
    assert decisions[0]["impact"]["file_count"] == 4


def test_agent_task_projection_only_uses_latest_request(client):
    task = _task(client, "Decision superseded by later request")
    with _db() as conn:
        first = _open_approval(conn, task["id"])
        # A later request of the same type supersedes the pending decision —
        # durably, in the rows themselves.
        second = _open_approval(conn, task["id"])
        conn.commit()

    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is True
    decisions = {d["id"]: d["status"] for d in
                 client.get(f"/agent-tasks/{task['id']}/decisions").json()["decisions"]}
    assert decisions == {first["id"]: "superseded", second["id"]: "pending"}


def test_model_prose_never_becomes_a_decision(client, monkeypatch):
    """A next step the model WRITES is just prose — only a gated tool raises a
    Decision (v1.11). No 'Decision required' appears out of nowhere."""
    from app.agent_runtime import session_agent
    task = _task(client, "Read-only follow-up suggestion")
    client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": "sk-TESTKEY-DONOTLEAK-0001"})
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: {
        "answer": "You should import the access logs next so I can confirm this.",
        "skills_used": [], "skills_offered": [], "evidence_used": [], "evidence_gaps": [],
        "tool_activity": []})
    execution = client.post(f"/agent-tasks/{task['id']}/executions",
                            json={"direction": "why 403?"}).json()["execution"]
    import time
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        row = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}").json()
        if row["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert row["status"] == "completed"
    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is False
    assert client.get(f"/agent-tasks/{task['id']}/decisions").json()["decisions"] == []


def test_agent_task_search_keeps_durable_decision_state(client):
    task = _task(client, "Evidence approval task")
    with _db() as conn:
        _open_approval(conn, task["id"])
        conn.commit()

    rows = client.get("/agent-tasks", params={"q": "Evidence approval"}).json()
    assert len(rows) == 1
    assert rows[0]["id"] == task["id"]
    assert rows[0]["requires_decision"] is True


def test_resolving_a_decision_clears_the_block_and_records_the_call(client):
    task = _task(client, "Approve the import")
    with _db() as conn:
        decision = _open_approval(conn, task["id"])
        conn.commit()
    dec_id = decision["id"]

    r = client.post(f"/agent-tasks/{task['id']}/decisions/{dec_id}/resolve",
                    json={"resolution": "approved"})
    assert r.status_code == 200
    body = r.json()
    assert body["decision"]["status"] == "approved"
    assert body["decision"]["scope"] == "once"
    assert body["decision"]["resolved_at"]
    # Approval wakes the tool that raised it; there is no hand-over dialog.
    assert body["prepared"] is None

    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is False

    # Resolving twice is a conflict, not a silent overwrite.
    again = client.post(f"/agent-tasks/{task['id']}/decisions/{dec_id}/resolve",
                        json={"resolution": "declined"})
    assert again.status_code == 409
