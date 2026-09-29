"""v8: the bugs the v7 review found stay fixed."""

from __future__ import annotations

import time

from app.agent.session import to_input
from app.agent.runtime import RUNTIME
from app.core import store
from app.estate import notes, store as estate, watch

from .fake_model import FakeModel, text_turn
from .test_v500_runtime import _settle, _start, _use


def _item(seq, typ, turn="t1", **payload):
    return {"seq": seq, "id": f"i{seq}", "turn_id": turn, "type": typ, "payload": payload}


def test_a_steer_while_a_tool_runs_keeps_the_tools_real_result():
    items = [_item(1, "user_message", text="Check it"),
             _item(2, "tool_call", call_id="c1", name="list_buckets", args={}),
             _item(3, "steer", text="only prod"),
             _item(4, "tool_output", call_id="c1", model_output="3 buckets"),
             _item(5, "agent_message", text="Done.")]
    out = to_input(items)
    outputs = [m for m in out if m.get("type") == "function_call_output"]
    assert outputs[0]["output"] == "3 buckets"
    kinds = [m.get("type") or m.get("role") for m in out]
    assert kinds.index("function_call_output") < kinds.index("user", 1)  # the steer follows the result


def test_a_carried_steer_is_read_once_as_the_next_direction():
    items = [_item(1, "user_message", text="First"),
             _item(2, "steer", text="also logs"),
             _item(3, "agent_message", text="Answer."),
             _item(4, "notice", event="carried", steers=1),
             _item(5, "user_message", turn="t2", text="also logs")]
    texts = [m.get("content") for m in to_input(items) if m.get("role") == "user"]
    assert texts == ["First", "also logs"]


def test_a_steer_after_the_last_model_call_becomes_the_next_direction(client):
    long = "Every bucket was reachable and nothing needs care today. " * 6
    with FakeModel([text_turn(long), text_turn("Logs look fine.")], delay_s=0.05) as fake:
        _use(client, fake)
        tid = _start(client, "Check my buckets")
        deadline = time.monotonic() + 10
        while not RUNTIME.is_running(tid) and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.3)  # the only model call is already streaming
        assert client.post(f"/tasks/{tid}/steer", json={"text": "also check the logs"}).json()["steered"]
        snap = _settle(client, tid)
        time.sleep(0.2)
        snap = _settle(client, tid)
    directions = [t["direction"] for t in snap["turns"]]
    assert directions == ["Check my buckets", "also check the logs"]
    users = [m["content"] for m in fake.requests[-1]["messages"] if m.get("role") == "user"]
    assert sum("also check the logs" in u for u in users) == 1


def test_a_withdrawn_direction_never_becomes_the_head_again(client, conn):
    with FakeModel([text_turn("One."), text_turn("Fork."), text_turn("Two.")]) as fake:
        _use(client, fake)
        tid = _start(client, "First")
        _settle(client, tid)
        first = client.get(f"/tasks/{tid}").json()["turns"][0]["id"]
        # A queued follow-up, withdrawn before it runs.
        queued = store.create_turn(conn, tid, "WITHDRAWN", parent_turn_id=first)
        assert RUNTIME.cancel_queued(conn, tid, queued["id"])
        client.post(f"/tasks/{tid}/turns", json={"direction": "Other", "parent_turn_id": ""})
        _settle(client, tid)
        client.put(f"/tasks/{tid}/head", json={"turn_id": first})
        snap = client.get(f"/tasks/{tid}").json()
        assert [t["direction"] for t in snap["turns"]] == ["First"]
        client.post(f"/tasks/{tid}/turns", json={"direction": "Follow"})
        _settle(client, tid)
    users = [m["content"] for m in fake.requests[-1]["messages"] if m.get("role") == "user"]
    assert not any("WITHDRAWN" in u for u in users)


def test_withdraw_and_run_cannot_both_win(conn, client):
    tid = client.post("/tasks", json={}).json()["task"]["id"]
    t = store.create_turn(conn, tid, "x")
    assert store.transition(conn, t["id"], "queued", "cancelled")
    assert not store.transition(conn, t["id"], "queued", "running")
    assert store.get_turn(conn, t["id"])["status"] == "cancelled"
    # …and a withdrawn Direction cannot be "resumed" into running.
    assert client.post(f"/tasks/{tid}/turns/{t['id']}/resume").status_code in (404, 409, 422)


def test_blank_directions_and_steers_are_refused(client):
    tid = client.post("/tasks", json={}).json()["task"]["id"]
    assert client.post(f"/tasks/{tid}/turns", json={"direction": "   "}).status_code == 422
    assert client.post(f"/tasks/{tid}/steer", json={"text": "\n\t "}).status_code == 422


def test_task_search_treats_wildcards_literally(client, conn):
    store.create_task(conn, "acme_prod review")
    store.create_task(conn, "plain")
    titles = [t["title"] for t in client.get("/tasks", params={"q": "_"}).json()["tasks"]]
    assert titles == ["acme_prod review"]


def test_an_absurd_resume_point_is_refused(client):
    tid = client.post("/tasks", json={}).json()["task"]["id"]
    assert client.get(f"/tasks/{tid}/events", params={"after": 10**20}).status_code == 422


def _provider(conn):
    conn.execute("INSERT INTO cloud_providers (id, name, provider_type, created_at, updated_at) "
                 "VALUES ('p1', 'prod', 's3', 'x', 'x')")
    conn.commit()


def test_a_failed_review_does_not_invent_a_bucket(conn):
    _provider(conn)
    estate.ingest_review(conn, "p1", "typo-bucket", {"security": {"success": False, "error": "NoSuchBucket"}})
    assert conn.execute("SELECT COUNT(*) FROM estate_buckets").fetchone()[0] == 0


def test_an_accept_reason_leaves_when_the_risk_resolves(conn):
    _provider(conn)
    estate.upsert_bucket(conn, "p1", "b")
    estate.observe(conn, "p1", "b", {"no_default_encryption": True}, source="survey")
    iid = conn.execute("SELECT id FROM issues").fetchone()["id"]
    estate.set_accepted(conn, iid, True, reason="Test bucket, no data")
    assert any("Test bucket" in n["text"] for n in notes.list_notes(conn))
    estate.observe(conn, "p1", "b", {"no_default_encryption": False}, source="survey")
    estate.observe(conn, "p1", "b", {"no_default_encryption": True}, source="survey")
    conn.commit()
    assert conn.execute("SELECT status FROM issues").fetchone()["status"] == "recurred"
    assert not any("Test bucket" in n["text"] for n in notes.list_notes(conn))


def test_a_shorter_watch_interval_brings_the_next_run_closer(conn):
    _provider(conn)
    watch.set_watch(conn, "p1", enabled=True, interval_hours=168)
    conn.execute("UPDATE watch_schedules SET next_run_at = '2999-01-01T00:00:00Z' WHERE provider_id = 'p1'")
    conn.commit()
    watch.set_watch(conn, "p1", enabled=True, interval_hours=6)
    nxt = conn.execute("SELECT next_run_at FROM watch_schedules WHERE provider_id = 'p1'").fetchone()[0]
    assert nxt < "2999-01-01T00:00:00Z"
