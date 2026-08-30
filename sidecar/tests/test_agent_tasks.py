"""Product-level Agent Task projection tests.

The task command center cannot depend on the browser's live run store: a durable
Decision must still be visible after reload/restart, and historical decisions
must stop blocking once a later Agent Work Result supersedes them.
"""

import sqlite3

from app import config
from app.repositories import sessions as sessions_repo


def _db():
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def _task(client, title: str):
    return client.post("/sessions", json={"title": title, "goal": "inspect storage"}).json()


def test_agent_task_projection_persists_current_decision(client):
    task = _task(client, "Review bounded evidence import")
    with _db() as conn:
        sessions_repo.add_message(conn, task["id"], "user", "Inspect the evidence first.")
        sessions_repo.add_message(
            conn,
            task["id"],
            "assistant",
            "I need your confirmation before importing bounded evidence.",
            proposed_actions=[{
                "action_type": "run_access_log_analysis",
                "title": "Import access-log evidence",
                "reason": "This operation reads bounded evidence files.",
                "requires_confirmation": True,
                "confidence": "high",
                "source_run_ids": [],
            }],
        )

    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is True


def test_agent_task_projection_only_uses_latest_work_result(client):
    task = _task(client, "Decision superseded by later result")
    with _db() as conn:
        sessions_repo.add_message(conn, task["id"], "user", "First direction")
        sessions_repo.add_message(
            conn,
            task["id"],
            "assistant",
            "Decision required.",
            proposed_actions=[{
                "action_type": "run_inventory_analysis",
                "title": "Import inventory evidence",
                "requires_confirmation": True,
            }],
        )
        sessions_repo.add_message(conn, task["id"], "user", "Use the evidence I already attached instead.")
        sessions_repo.add_message(
            conn,
            task["id"],
            "assistant",
            "Completed from already attached evidence.",
            proposed_actions=[],
        )

    rows = client.get("/agent-tasks").json()
    projected = next(row for row in rows if row["id"] == task["id"])
    assert projected["requires_decision"] is False


def test_agent_task_search_keeps_durable_decision_state(client):
    task = _task(client, "Evidence approval task")
    with _db() as conn:
        sessions_repo.add_message(
            conn,
            task["id"],
            "assistant",
            "Waiting for approval.",
            proposed_actions=[{
                "action_type": "run_access_log_analysis",
                "title": "Review import",
                "requires_confirmation": True,
            }],
        )

    rows = client.get("/agent-tasks", params={"q": "Evidence approval"}).json()
    assert len(rows) == 1
    assert rows[0]["id"] == task["id"]
    assert rows[0]["requires_decision"] is True
