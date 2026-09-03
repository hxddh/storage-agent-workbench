"""v0.63.0 — the SSE turn, end to end.

The app streams. `POST /messages` is the fallback the client reaches for only
when the stream fails, so the path the released build actually runs on every
question is the durable execution stream — and it had never been driven end to end
either, for the same reason: it needed a model.

This is where the shipped bug was *felt*. The stream succeeded, the answer was
watched arriving, and then the reload that turns the streamed bubble into a
persisted message hit the 500 — so the answer stayed a live bubble with no turn
footer and no actions, and the thread never grew. So the assertions here are
deliberately about the seam AFTER the stream ends: what is persisted, and
whether the session can be opened.
"""
from __future__ import annotations


import pytest

from .fake_model import FakeModel, text_turn, tool_turn

SKILL = "storageops-lifecycle-cost"

ANSWER = "Objects under logs/ have no expiry, which is the cost.\n"


def _events(client, sid, question="why is storage growing?", turn_id="t1"):
    """Submit a durable Execution and return its event log, in order."""
    from app.task_runtime import runtime
    r = client.post(f"/agent-tasks/{sid}/executions",
                    json={"direction": question, "turn_id": turn_id})
    assert r.status_code in (200, 201), r.text
    execution = r.json()["execution"]
    runtime.wait_for_completion(execution["id"], 60.0)
    res = client.get(f"/agent-tasks/{sid}/events?after=0&limit=1000")
    assert res.status_code == 200, res.text[:200]
    return [(e["event_type"], e["payload"]) for e in res.json()["events"]
            if e["execution_id"] == execution["id"]]


@pytest.fixture
def streamed(client):
    with FakeModel([tool_turn("read_skill", {"name": SKILL}), text_turn(ANSWER)]) as model:
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible",
            "base_url": model.base_url, "model": "fake-model", "api_key": "k",
        })
        sid = client.post("/sessions", json={"title": "growth"}).json()["id"]
        yield client, sid, _events(client, sid)


def test_the_stream_reports_the_tool_then_the_answer_then_done(streamed):
    _, _, events = streamed
    kinds = [k for k, _ in events]
    assert "tool.completed" in kinds
    assert "message.completed" in kinds
    assert kinds[-1] == "execution.status", kinds[-3:]
    assert events[-1][1]["status"] == "completed"


def test_the_streamed_answer_is_the_final_segment(streamed):
    _, _, events = streamed
    finals = [d for k, d in events if k == "message.completed" and d.get("final")]
    assert finals and "no expiry" in finals[-1]["text"]


def test_the_answer_is_committed_as_a_final_segment(streamed):
    """v1.11: the live stream closes the answer with `message.completed`
    (final=true) carrying the fully sanitized text."""
    client, sid, _ = streamed
    events = client.get(f"/agent-tasks/{sid}/events").json()["events"]
    finals = [e["payload"] for e in events if e["event_type"] == "message.completed"]
    assert finals and finals[-1]["final"] is True
    assert "no expiry" in finals[-1]["text"]


def test_the_session_opens_after_a_streamed_turn(streamed):
    """The exact seam the released app failed at: the stream finishes, the
    client reloads, and the reload must succeed."""
    client, sid, _ = streamed
    detail = client.get(f"/sessions/{sid}")
    assert detail.status_code == 200, detail.text
    msgs = detail.json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert "no expiry" in (msgs[-1]["content"] or "")


def test_the_streamed_turn_persisted_its_trace_and_its_grounding(streamed):
    client, sid, _ = streamed
    msg = client.get(f"/sessions/{sid}").json()["messages"][-1]
    assert [a["tool"] for a in msg["tool_activity"]] == ["read_skill"]
    assert msg["tool_activity"][0]["ok"] is True
    assert msg["grounding"]["skills_used"] == [SKILL]


def test_the_turn_is_no_longer_reported_as_running(streamed):
    """A finished turn must clear its handle, or a reopened window shows an
    eternal 'a turn is still running' banner."""
    client, sid, _ = streamed
    assert client.get(f"/agent-tasks/{sid}/state").json()["active_execution"] is None


def test_a_second_streamed_turn_keeps_the_first(client):
    with FakeModel([
        tool_turn("read_skill", {"name": SKILL}), text_turn(ANSWER),
        text_turn("Second: the noncurrent versions are the rest of it."),
    ]) as model:
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible",
            "base_url": model.base_url, "model": "fake-model", "api_key": "k",
        })
        sid = client.post("/sessions", json={"title": "growth"}).json()["id"]
        _events(client, sid, "first question", "t1")
        _events(client, sid, "second question", "t2")

        detail = client.get(f"/sessions/{sid}")
        assert detail.status_code == 200, detail.text
        contents = [m["content"] for m in detail.json()["messages"]]
        assert "first question" in contents and "second question" in contents
        assert detail.json()["message_total"] == 4


def test_a_stream_with_no_model_configured_is_a_clean_422(client):
    """A fresh install must get the documented fallback signal, not a 500."""
    sid = client.post("/sessions", json={"title": "s"}).json()["id"]
    res = client.post(f"/agent-tasks/{sid}/executions", json={"direction": "hi", "turn_id": "t1"})
    assert res.status_code == 422, res.text
    # And nothing dangles: no half-written user message in the thread.
    assert client.get(f"/sessions/{sid}").json()["message_total"] == 0
