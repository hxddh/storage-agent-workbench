"""v7: follow-ups are exact — the model reads every Direction once, in branch
order, in a request a strict Chat Completions endpoint accepts."""

from __future__ import annotations

import time

from .fake_model import (FakeModel, chat_violations, commentary_tool_turn, parallel_turn, text_turn,
                         tool_turn)
from .test_v500_runtime import _settle, _start, _use


def _users(req: dict) -> list[str]:
    return [m["content"] for m in req["messages"] if m.get("role") == "user" and isinstance(m.get("content"), str)]


def _strict(fake: FakeModel) -> None:
    for n, req in enumerate(fake.requests):
        assert chat_violations(req["messages"]) == [], (n, chat_violations(req["messages"]))


def test_three_directions_replay_exactly_and_strictly(client):
    concl = {"answer": "No files.", "findings": [{"title": "Nothing", "severity": "info"}], "next_steps": []}
    with FakeModel([
        commentary_tool_turn("Let me look.", "list_uploaded_files", {}),
        tool_turn("record_conclusion", concl),
        text_turn("Answer one."),
        commentary_tool_turn("Checking again.", "list_uploaded_files", {}),
        text_turn("Answer two."),
        text_turn("Answer three."),
    ]) as fake:
        _use(client, fake)
        tid = _start(client, "Direction one")
        _settle(client, tid)
        client.post(f"/tasks/{tid}/turns", json={"direction": "Direction two"})
        _settle(client, tid)
        client.post(f"/tasks/{tid}/turns", json={"direction": "Direction three"})
        _settle(client, tid)
    _strict(fake)
    last = fake.requests[-1]
    assert [u for u in _users(last) if u.startswith("Direction")] == ["Direction one", "Direction two", "Direction three"]
    assert last["messages"][-1] == {"role": "user", "content": "Direction three"} or \
        last["messages"][-1].get("content") == "Direction three"
    # Commentary and its call are ONE assistant message.
    merged = [m for m in last["messages"] if m.get("role") == "assistant" and m.get("tool_calls")
              and m.get("content") == "Checking again."]
    assert merged, [m for m in last["messages"] if m.get("role") == "assistant"]


def test_a_follow_up_queued_while_a_turn_runs_comes_after_that_turn(client):
    with FakeModel([
        commentary_tool_turn("Let me look.", "list_uploaded_files", {}),
        text_turn("Answer one, streamed slowly so the follow-up is queued meanwhile."),
        text_turn("Answer two."),
    ], delay_s=0.03) as fake:
        _use(client, fake)
        tid = _start(client, "Direction one")
        time.sleep(0.15)
        client.post(f"/tasks/{tid}/turns", json={"direction": "Direction two"})
        snap = _settle(client, tid)
    _strict(fake)
    second = [r for r in fake.requests if "Direction two" in _users(r)][0]
    msgs = second["messages"]
    assert msgs[-1].get("content") == "Direction two", msgs[-3:]
    # The snapshot reads in branch order too: turn one's items, then turn two's.
    order = [snap["turns"].index(next(t for t in snap["turns"] if t["id"] == i["turn_id"])) for i in snap["items"]]
    assert order == sorted(order)


def test_a_parallel_batch_with_a_conclusion_replays_calls_then_outputs(client):
    concl = {"answer": "x", "findings": [], "next_steps": []}
    with FakeModel([
        parallel_turn([("list_uploaded_files", {}), ("record_conclusion", concl), ("query_estate", {})],
                      text="Looking at both."),
        text_turn("One."),
        text_turn("Two."),
    ]) as fake:
        _use(client, fake)
        tid = _start(client, "D1")
        _settle(client, tid)
        client.post(f"/tasks/{tid}/turns", json={"direction": "D2"})
        snap = _settle(client, tid)
    assert [t["status"] for t in snap["turns"]] == ["completed", "completed"]
    _strict(fake)


def test_withdrawing_a_queued_direction_takes_it_off_the_branch(client):
    with FakeModel([text_turn("First answer, slow enough to queue two more behind it."),
                    text_turn("Third answer.")], delay_s=0.03) as fake:
        _use(client, fake)
        tid = _start(client, "First")
        time.sleep(0.1)
        second = client.post(f"/tasks/{tid}/turns", json={"direction": "Second (withdrawn)"}).json()
        client.post(f"/tasks/{tid}/turns", json={"direction": "Third"})
        assert client.delete(f"/tasks/{tid}/turns/{second['turn_id']}").status_code == 200
        snap = _settle(client, tid)
    assert [t["direction"] for t in snap["turns"]] == ["First", "Third"]
    assert all("Second (withdrawn)" not in _users(r) for r in fake.requests)


def test_recovery_runs_the_continuation_before_the_queued_follow_up(client, conn):
    from app.agent.runtime import RUNTIME
    from app.core import store

    with FakeModel([text_turn("Continued A."), text_turn("Answer B.")]) as fake:
        _use(client, fake)
        task = store.create_task(conn, "t")
        a = store.create_turn(conn, task["id"], "Direction A")
        store.append_item(conn, task["id"], a["id"], "user_message", {"text": "Direction A"})
        store.set_turn_status(conn, a["id"], "running")
        b = store.create_turn(conn, task["id"], "Direction B")
        store.append_item(conn, task["id"], b["id"], "user_message", {"text": "Direction B"})
        RUNTIME.recover()
        snap = _settle(client, task["id"])
    kinds = [(t["kind"], t["direction"], t["status"]) for t in snap["turns"]]
    assert kinds == [("direction", "Direction A", "interrupted"), ("resume", "Direction A", "completed"),
                     ("direction", "Direction B", "completed")]
    answer_b = next(i for i in snap["items"] if i["type"] == "agent_message" and i["payload"]["text"] == "Answer B.")
    assert answer_b["turn_id"] == b["id"]


def test_a_stop_writes_one_lifecycle_notice(client):
    with FakeModel([text_turn("x " * 400)], delay_s=0.02) as fake:
        _use(client, fake)
        tid = _start(client, "long")
        time.sleep(0.3)
        client.post(f"/tasks/{tid}/stop")
        snap = _settle(client, tid)
    events = [i["payload"]["event"] for i in snap["items"] if i["type"] == "notice"]
    assert events.count("cancelled") == 1 and "stopped" not in events


def test_a_steer_reaches_the_model_once(client):
    with FakeModel([commentary_tool_turn("Surveying first.", "list_uploaded_files", {}),
                    text_turn("Focused on logs.")], delay_s=0.05) as fake:
        _use(client, fake)
        tid = _start(client, "Look around")
        time.sleep(0.2)
        client.post(f"/tasks/{tid}/steer", json={"text": "Focus on logs"})
        snap = _settle(client, tid)
    assert "steer" in [i["type"] for i in snap["items"]]
    for req in fake.requests:
        steers = [m for m in req["messages"] if isinstance(m.get("content"), str) and "Focus on logs" in m["content"]]
        assert len(steers) <= 1


def test_reasoning_models_get_no_temperature():
    from app.agent import models
    _, s = models.build({"kind": "openai-compatible", "model": "o3-mini", "base_url": "http://x", "api_key": "k",
                         "api_style": "chat"}, [], tools_allowed=False)
    assert getattr(s, "temperature", None) is None
    _, s = models.build({"kind": "openai-compatible", "model": "gpt-4.1", "base_url": "http://x", "api_key": "k",
                         "api_style": "chat"}, [], tools_allowed=False)
    assert s.temperature is not None


def test_a_new_follower_sees_each_delta_exactly_once():
    import asyncio

    from app.core import hub

    async def main():
        loop = asyncio.get_running_loop()
        hub.delta("t-hub", "u", "seg", "Hello ")
        sub, live = hub.subscribe_with_live("t-hub", loop)
        hub.delta("t-hub", "u", "seg", "world")
        await asyncio.sleep(0.05)
        queued = []
        while not sub.queue.empty():
            queued.append(sub.queue.get_nowait()[1]["text"])
        hub.unsubscribe("t-hub", sub)
        hub.close_segment("t-hub", "seg")
        return live["text"], queued

    snapshot, queued = asyncio.run(main())
    assert snapshot + "".join(queued) == "Hello world"


def test_a_steer_closes_the_running_turns_open_segment_first(client, conn):
    from app.agent.recorder import Recorder
    from app.agent.runtime import RUNTIME, _Live
    from app.core import store

    task = store.create_task(conn, "t")
    turn = store.create_turn(conn, task["id"], "Look", status="running")
    rec = Recorder(task["id"], turn["id"])
    try:
        rec.delta("Half a sentence written before the steer")
        with RUNTIME._lock:
            RUNTIME._live[task["id"]] = _Live(turn["id"], recorder=rec)
        try:
            assert RUNTIME.steer(conn, task["id"], "Focus on logs")["steered"] is True
        finally:
            with RUNTIME._lock:
                RUNTIME._live.pop(task["id"], None)
    finally:
        rec.close()
    items = store.items_for_turns(conn, [turn["id"]])
    assert [i["type"] for i in items] == ["agent_message", "steer"]
