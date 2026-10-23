"""v14: one window, bounded history, and the retired fields stay retired."""

from __future__ import annotations

from app.core import store


def _task_with_turns(conn, count: int) -> tuple[str, list[str]]:
    task = store.create_task(conn, "long task")
    ids: list[str] = []
    for i in range(count):
        turn = store.create_turn(conn, task["id"], f"Direction {i}", status="completed")
        store.append_item(conn, task["id"], turn["id"], "user_message", {"text": f"Direction {i}"})
        store.append_item(conn, task["id"], turn["id"], "agent_message", {"text": f"Answer {i}"})
        ids.append(turn["id"])
    return task["id"], ids


def test_a_snapshot_is_bounded_and_history_loads_the_rest(client, conn):
    task_id, ids = _task_with_turns(conn, 65)
    snap = client.get(f"/tasks/{task_id}").json()
    assert len(snap["turns"]) == 60
    assert snap["has_older"] is True
    assert snap["oldest_turn_id"] == ids[-60]
    assert len(snap["items"]) == 120

    page = client.get(f"/tasks/{task_id}/history", params={"before": ids[-60], "limit": 20}).json()
    assert [t["id"] for t in page["turns"]] == ids[0:5]
    assert page["has_older"] is False
    assert page["oldest_turn_id"] == ids[0]
    assert [i["payload"]["text"] for i in page["items"] if i["type"] == "user_message"] == [
        f"Direction {i}" for i in range(5)]

    again = client.get(f"/tasks/{task_id}/history", params={"before": ids[0]}).json()
    assert again == {"turns": [], "items": [], "has_older": False, "oldest_turn_id": None}


def test_retired_task_input_fields_are_refused(client):
    refused = client.post("/tasks", json={"direction": "look", "origin": "quick_ask", "context": []})
    assert refused.status_code == 422
    tid = client.post("/tasks", json={}).json()["task"]["id"]
    refused = client.post(f"/tasks/{tid}/turns", json={"direction": "look", "context": [], "parent_turn_id": None})
    assert refused.status_code == 422
