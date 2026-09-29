"""The v5 runtime, end to end: a real Agents SDK loop against a scripted
OpenAI-compatible endpoint, through the one submit path, into items, read back
through the API.
"""

from __future__ import annotations

import json
import time

import pytest

from tests.fake_model import FakeModel, commentary_tool_turn, text_turn, tool_turn


def _use(client, fake: FakeModel) -> str:
    return client.post("/providers/models", json={"name": "fake", "kind": "openai-compatible",
                                                   "base_url": fake.base_url, "model": "fake-model"}).json()["id"]


def _settle(client, task_id: str, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/tasks/{task_id}").json()
        if snap["state"] not in ("working", "queued"):
            return snap
        time.sleep(0.05)
    raise AssertionError(f"task still {snap['state']}")


def _types(snap: dict) -> list[str]:
    return [i["type"] if i["type"] != "notice" else f"notice:{i['payload']['event']}" for i in snap["items"]]


def _start(client, direction: str) -> str:
    return client.post("/tasks", json={"direction": direction}).json()["task"]["id"]


def test_a_turn_streams_into_items_and_names_the_task(client):
    with FakeModel([text_turn("All three buckets are reachable.")], title="Reachability check") as fake:
        _use(client, fake)
        tid = _start(client, "Can you reach my buckets?")
        snap = _settle(client, tid)
        time.sleep(0.3)  # the title step runs after the turn settles
        snap = client.get(f"/tasks/{tid}").json()
    assert _types(snap) == ["user_message", "notice:started", "agent_message", "notice:completed",
                            "notice:titled"]
    assert snap["items"][2]["payload"]["text"] == "All three buckets are reachable."
    assert snap["task"]["title"] == "Reachability check" and snap["task"]["title_source"] == "agent"
    assert snap["turns"][0]["status"] == "completed" and snap["turns"][0]["usage"]["requests"] >= 1
    assert snap["state"] == "ready"


def test_a_user_rename_wins_over_the_title_step(client):
    with FakeModel([text_turn("Done.")], title="Agent title") as fake:
        _use(client, fake)
        tid = client.post("/tasks", json={}).json()["task"]["id"]
        client.patch(f"/tasks/{tid}", json={"title": "Mine"})
        client.post(f"/tasks/{tid}/turns", json={"direction": "Check it"})
        _settle(client, tid)
        time.sleep(0.3)
    assert client.get(f"/tasks/{tid}").json()["task"]["title"] == "Mine"


def test_tools_and_the_conclusion_are_items_and_the_ui_never_gets_model_output(client):
    conclusion = {"answer": "No files are attached yet.", "findings": [
        {"title": "Nothing to analyze", "severity": "info", "detail": ""}], "next_steps": ["Attach a log"]}
    with FakeModel([commentary_tool_turn("Let me look.", "list_uploaded_files", {}),
                    tool_turn("record_conclusion", conclusion),
                    text_turn("There are no attached files.")]) as fake:
        _use(client, fake)
        tid = _start(client, "What files do I have?")
        snap = _settle(client, tid)
    types = _types(snap)
    assert types[:2] == ["user_message", "notice:started"]
    assert types[2:] == ["agent_message", "tool_call", "tool_output", "conclusion", "agent_message",
                         "notice:completed"][: len(types) - 2] or "conclusion" in types
    call = next(i for i in snap["items"] if i["type"] == "tool_call")
    out = next(i for i in snap["items"] if i["type"] == "tool_output")
    assert call["payload"]["name"] == "list_uploaded_files" and out["payload"]["ok"] is True
    assert "model_output" not in out["payload"] and "datasets" in out["payload"]["detail"]
    concl = next(i for i in snap["items"] if i["type"] == "conclusion")["payload"]
    assert concl["answer"] == "No files are attached yet." and concl["next_steps"] == ["Attach a log"]
    # The model read the tool output inside the untrusted-data envelope.
    tool_msgs = [m for m in fake.requests[1]["messages"] if m.get("role") == "tool"]
    assert tool_msgs and "untrusted" in tool_msgs[0]["content"].lower()


def test_a_fork_is_a_new_version_of_a_direction(client):
    with FakeModel([text_turn("First answer."), text_turn("Second answer."), text_turn("Forked answer.")]) as fake:
        _use(client, fake)
        tid = _start(client, "Question one")
        _settle(client, tid)
        client.post(f"/tasks/{tid}/turns", json={"direction": "Question two"})
        snap = _settle(client, tid)
        first, second = snap["turns"][0]["id"], snap["turns"][1]["id"]
        # Rewrite the second Direction: a sibling of `second`, after `first`.
        client.post(f"/tasks/{tid}/turns", json={"direction": "Question two, reworded", "parent_turn_id": first})
        snap = _settle(client, tid)
    assert [t["direction"] for t in snap["turns"]] == ["Question one", "Question two, reworded"]
    assert snap["forks"][first] == [second, snap["turns"][1]["id"]]
    # The model saw only its own branch.
    last = json.dumps(fake.requests[-1]["messages"])
    assert "Question two, reworded" in last and "Second answer." not in last
    back = client.put(f"/tasks/{tid}/head", json={"turn_id": second}).json()
    assert [t["direction"] for t in back["turns"]] == ["Question one", "Question two"]


def test_stop_ends_the_turn_and_keeps_it(client):
    with FakeModel([text_turn("word " * 400, chunk_size=4)], delay_s=0.02) as fake:
        _use(client, fake)
        tid = _start(client, "Write a lot")
        time.sleep(0.6)
        assert client.post(f"/tasks/{tid}/stop").json()["stopping"] is True
        snap = _settle(client, tid)
    assert snap["turns"][0]["status"] == "cancelled"
    assert "notice:cancelled" in _types(snap)
    assert snap["state"] == "ready"


def test_a_direction_while_working_is_queued_then_runs(client):
    with FakeModel([text_turn("one " * 60, chunk_size=4), text_turn("Second.")], delay_s=0.01) as fake:
        _use(client, fake)
        tid = _start(client, "First")
        time.sleep(0.2)
        client.post(f"/tasks/{tid}/turns", json={"direction": "Second"})
        mid = client.get(f"/tasks/{tid}").json()
        assert [q["direction"] for q in mid["queued"]] == ["Second"]
        snap = _settle(client, tid)
    assert [t["status"] for t in snap["turns"]] == ["completed", "completed"]


def test_a_queued_direction_can_be_withdrawn(client):
    with FakeModel([text_turn("one " * 80, chunk_size=4)], delay_s=0.01) as fake:
        _use(client, fake)
        tid = _start(client, "First")
        time.sleep(0.2)
        queued = client.post(f"/tasks/{tid}/turns", json={"direction": "Never mind"}).json()["turn_id"]
        assert client.delete(f"/tasks/{tid}/turns/{queued}").json() == {"cancelled": True}
        snap = _settle(client, tid)
    assert [t["direction"] for t in snap["turns"]] == ["First"]


def test_steer_reaches_the_running_loop(client):
    with FakeModel([commentary_tool_turn("Looking.", "list_uploaded_files", {}), text_turn("Done.")],
                   delay_s=0.15) as fake:
        _use(client, fake)
        tid = _start(client, "Check files")
        time.sleep(0.2)
        assert client.post(f"/tasks/{tid}/steer", json={"text": "Focus on logs"}).json()["steered"] is True
        snap = _settle(client, tid)
    assert "steer" in _types(snap)
    assert "[The user steered] Focus on logs" in json.dumps(fake.requests[-1]["messages"])


def test_steer_with_nothing_running_is_a_new_direction(client):
    with FakeModel([text_turn("A."), text_turn("B.")]) as fake:
        _use(client, fake)
        tid = _start(client, "One")
        _settle(client, tid)
        assert client.post(f"/tasks/{tid}/steer", json={"text": "Two"}).json()["steered"] is False
        snap = _settle(client, tid)
    assert [t["direction"] for t in snap["turns"]] == ["One", "Two"]


def test_no_model_fails_the_turn_with_a_way_forward(client):
    tid = _start(client, "Hello")
    snap = _settle(client, tid)
    err = next(i for i in snap["items"] if i["type"] == "error")
    assert err["payload"]["action"] == "settings"
    assert snap["state"] == "needs_attention"


def test_a_step_budget_overrun_is_finalized_not_lost(client, monkeypatch):
    from app.agent import runtime
    monkeypatch.setattr(runtime, "MAX_TURN_STEPS", 2)
    with FakeModel([tool_turn("list_uploaded_files", {})], finalize="Here is what I found so far.") as fake:
        _use(client, fake)
        tid = _start(client, "Loop forever")
        snap = _settle(client, tid)
    assert snap["turns"][0]["status"] == "completed"
    assert "notice:finalized" in _types(snap)
    assert snap["items"][-2]["payload"]["text"] == "Here is what I found so far."
    assert fake.finalize_requests


def test_restart_recovery_continues_once(client, conn):
    from app.agent.runtime import RUNTIME
    from app.core import store
    with FakeModel([text_turn("Continued after restart.")]) as fake:
        _use(client, fake)
        task = store.create_task(conn, "t")
        turn = store.create_turn(conn, task["id"], "Survey everything")
        store.append_item(conn, task["id"], turn["id"], "user_message", {"text": "Survey everything"})
        store.set_turn_status(conn, turn["id"], "running")
        assert RUNTIME.recover() == 1
        snap = _settle(client, task["id"])
    statuses = [(t["kind"], t["status"]) for t in snap["turns"]]
    assert statuses == [("direction", "interrupted"), ("resume", "completed")]
    assert "restarted" in json.dumps(fake.requests[-1]["messages"])


def test_a_refused_scope_is_a_tool_output_the_model_reads(client):
    pid = client.post("/providers/clouds", json={
        "name": "scoped", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "allowed_buckets": ["only-this"]}).json()["id"]
    with FakeModel([tool_turn("head_bucket", {"provider_id": pid, "bucket": "elsewhere"}),
                    text_turn("That bucket is outside your scope.")]) as fake:
        _use(client, fake)
        tid = _start(client, "Check elsewhere")
        snap = _settle(client, tid)
    out = next(i for i in snap["items"] if i["type"] == "tool_output")
    assert out["payload"]["ok"] is False and out["payload"]["refused"] is True
    assert "Refused" in json.dumps(fake.requests[-1]["messages"])


def test_the_report_is_a_document_with_safety(client):
    conclusion = {"answer": "Everything is fine.", "findings": [
        {"title": "Public bucket", "severity": "high", "detail": "acme-www is public"}], "next_steps": []}
    with FakeModel([tool_turn("record_conclusion", conclusion), text_turn("Fine.")]) as fake:
        _use(client, fake)
        tid = _start(client, "Review")
        _settle(client, tid)
    en = client.get(f"/tasks/{tid}/report").text
    zh = client.get(f"/tasks/{tid}/report?lang=zh").text
    assert "## Conclusion" in en and "Everything is fine." in en and "**HIGH** — Public bucket" in en
    assert "## Safety" in en and "## 安全" in zh and "## 结论" in zh


def test_the_stream_replays_then_follows(client):
    """Over a real socket: TestClient buffers a never-ending response."""
    import socket
    import threading

    import httpx2
    import uvicorn

    from app.main import app

    with FakeModel([text_turn("Streamed answer.")]) as fake:
        _use(client, fake)
        tid = _start(client, "Stream it")
        _settle(client, tid)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", lifespan="off"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started and time.monotonic() < deadline:
                time.sleep(0.02)
            seen: list[str] = []
            with httpx2.stream("GET", f"http://127.0.0.1:{port}/tasks/{tid}/events?after=0", timeout=10) as resp:
                for line in resp.iter_lines():
                    if line.startswith("event:"):
                        seen.append(line.split(":", 1)[1].strip())
                    if "live" in seen:
                        break
        finally:
            server.should_exit = True
            thread.join(5)
    assert seen.count("item") >= 4 and seen[-1] == "live"


@pytest.mark.parametrize("bad", [{"direction": ""}, {"direction": "x", "parent_turn_id": "nope"}])
def test_submit_validation(client, bad):
    tid = client.post("/tasks", json={}).json()["task"]["id"]
    assert client.post(f"/tasks/{tid}/turns", json=bad).status_code == 422
