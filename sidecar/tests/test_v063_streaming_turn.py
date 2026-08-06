"""v0.63.0 — the SSE turn, end to end.

The app streams. `POST /messages` is the fallback the client reaches for only
when the stream fails, so the path the released build actually runs on every
question is `POST /messages/stream` — and it had never been driven end to end
either, for the same reason: it needed a model.

This is where the shipped bug was *felt*. The stream succeeded, the answer was
watched arriving, and then the reload that turns the streamed bubble into a
persisted message hit the 500 — so the answer stayed a live bubble with no turn
footer and no actions, and the thread never grew. So the assertions here are
deliberately about the seam AFTER the stream ends: what is persisted, and
whether the session can be opened.
"""
from __future__ import annotations

import json

import pytest

from .fake_model import FakeModel, text_turn, tool_turn

SKILL = "storageops-lifecycle-cost"

ANSWER = """Objects under logs/ have no expiry, which is the cost.

```json
{"skills_used": ["%s"], "evidence_used": ["read_skill: lifecycle method"]}
```
""" % SKILL


def _events(client, sid, question="why is storage growing?", turn_id="t1"):
    """Drive the SSE endpoint and return the parsed events, in order."""
    out = []
    with client.stream("POST", f"/sessions/{sid}/messages/stream",
                       json={"content": question, "turn_id": turn_id}) as res:
        assert res.status_code == 200, res.read()
        event = None
        for line in res.iter_lines():
            line = line if isinstance(line, str) else line.decode()
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                raw = line.split(":", 1)[1].strip()
                try:
                    out.append((event, json.loads(raw)))
                except ValueError:
                    out.append((event, raw))
    return out


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
    assert "tool" in kinds
    assert "delta" in kinds
    assert kinds[-1] == "done", kinds[-3:]


def test_the_streamed_deltas_add_up_to_the_answer(streamed):
    _, _, events = streamed
    text = "".join(d if isinstance(d, str) else (d.get("text") or d.get("delta") or "")
                   for k, d in events if k == "delta")
    assert "no expiry" in text


def test_the_contract_block_never_appears_in_the_live_stream(streamed):
    """It is held back deliberately: a reader must not watch bookkeeping JSON
    scroll past mid-answer."""
    _, _, events = streamed
    text = "".join(d if isinstance(d, str) else (d.get("text") or d.get("delta") or "")
                   for k, d in events if k == "delta")
    assert "skills_used" not in text


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
    assert client.get(f"/sessions/{sid}/turn").json()["running"] is False


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
    res = client.post(f"/sessions/{sid}/messages/stream", json={"content": "hi", "turn_id": "t1"})
    assert res.status_code == 422, res.text
    # And nothing dangles: no half-written user message in the thread.
    assert client.get(f"/sessions/{sid}").json()["message_total"] == 0
