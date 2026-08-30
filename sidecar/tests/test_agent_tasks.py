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


def test_agent_task_projection_persists_current_decision(client):
    task = _task(client, "Review bounded evidence import")
    with _db() as conn:
        task_store.open_decisions_from_proposals(conn, task["id"], None, None,
                                                 [_gated_proposal()])
        conn.commit()

    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is True

    # The decision is a durable object, listable in its own right.
    decisions = client.get(f"/agent-tasks/{task['id']}/decisions").json()["decisions"]
    assert len(decisions) == 1
    assert decisions[0]["status"] == "pending"
    assert decisions[0]["action_type"] == "plan_access_log_import"


def test_agent_task_projection_only_uses_latest_work_result(client):
    task = _task(client, "Decision superseded by later result")
    with _db() as conn:
        task_store.open_decisions_from_proposals(conn, task["id"], None, None,
                                                 [_gated_proposal("Import inventory")])
        # A later Work Result with no gated proposals supersedes the pending
        # decision — durably, in the rows themselves.
        task_store.open_decisions_from_proposals(conn, task["id"], None, None, [])
        conn.commit()

    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is False
    decisions = client.get(f"/agent-tasks/{task['id']}/decisions").json()["decisions"]
    assert [d["status"] for d in decisions] == ["superseded"]


def test_ungated_proposals_do_not_block_as_decisions(client):
    """A read-only suggestion (the agent can just do it) is a proposal on the
    Work Result, never a blocking Decision — only confirmation-gated
    data-moving/artifact work raises one."""
    task = _task(client, "Read-only follow-up suggestion")
    with _db() as conn:
        task_store.open_decisions_from_proposals(conn, task["id"], None, None, [{
            "action_type": "run_diagnostic",
            "title": "Probe addressing style",
            "requires_confirmation": True,
        }])
        conn.commit()
    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is False


def test_agent_task_search_keeps_durable_decision_state(client):
    task = _task(client, "Evidence approval task")
    with _db() as conn:
        task_store.open_decisions_from_proposals(conn, task["id"], None, None,
                                                 [_gated_proposal("Review import")])
        conn.commit()

    rows = client.get("/agent-tasks", params={"q": "Evidence approval"}).json()
    assert len(rows) == 1
    assert rows[0]["id"] == task["id"]
    assert rows[0]["requires_decision"] is True


def test_resolving_a_decision_clears_the_block_and_records_the_call(client):
    task = _task(client, "Approve the import")
    with _db() as conn:
        decisions = task_store.open_decisions_from_proposals(
            conn, task["id"], None, None, [_gated_proposal()])
        conn.commit()
    dec_id = decisions[0]["id"]

    r = client.post(f"/agent-tasks/{task['id']}/decisions/{dec_id}/resolve",
                    json={"resolution": "approved"})
    assert r.status_code == 200
    body = r.json()
    assert body["decision"]["status"] == "approved"
    assert body["decision"]["resolved_at"]
    # Approval hands over to the confirmed flow; it never auto-executes.
    assert body["prepared"] is not None
    assert body["prepared"]["status"] in ("ready", "needs_input")

    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is False

    # Resolving twice is a conflict, not a silent overwrite.
    again = client.post(f"/agent-tasks/{task['id']}/decisions/{dec_id}/resolve",
                        json={"resolution": "declined"})
    assert again.status_code == 409
