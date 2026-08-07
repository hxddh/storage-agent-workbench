"""v0.65.0 — stopping a turn could throw the whole exchange away.

The streaming worker persists the user message and the assistant answer
**together**, and only when the run produced a final contract:

    data = final.get("data")
    if data is not None:
        repo.add_message(..., "user", body.content)
        mid = repo.add_message(..., "assistant", data["answer"], ...)

That is deliberate on the failure path — a turn that dies before answering must
not leave a dangling question in the thread. But it means a CANCELLED turn keeps
nothing unless cancellation still finalizes: not the partial answer the user had
already read, and not the question they asked.

Found from the browser: after pressing Stop the thread said *Stopped by user* and
showed the partial text, and a reload came back to an empty investigation.
Roughly half the time. This is the server half of that, isolated from the
client's stream abort so the two cannot be confused.
"""
from __future__ import annotations

import json
import threading
import time

import pytest

from .fake_model import FakeModel, text_turn

LONG = " ".join(f"Paragraph {i} of a long answer about acme-logs." for i in range(40))


def _provider(client, model):
    client.post("/model-providers", json={
        "name": "fake", "provider_type": "openai-compatible",
        "base_url": model.base_url, "model": "fake-model", "api_key": "k",
    })


def _run_and_cancel(client, cancel_after_s: float = 0.6):
    """Start a streamed turn, cancel it mid-answer, return (session_id, events)."""
    with FakeModel([text_turn(LONG)], delay_s=0.05) as model:
        _provider(client, model)
        sid = client.post("/sessions", json={"title": "acme-logs"}).json()["id"]

        def cancel_soon():
            time.sleep(cancel_after_s)
            client.post(f"/sessions/{sid}/turns/turn-1/cancel")

        t = threading.Thread(target=cancel_soon, daemon=True)
        t.start()
        events = []
        with client.stream("POST", f"/sessions/{sid}/messages/stream",
                           json={"content": "why does acme-logs return 403?",
                                 "turn_id": "turn-1"}) as res:
            assert res.status_code == 200, res.read()
            kind = None
            for line in res.iter_lines():
                line = line if isinstance(line, str) else line.decode()
                if line.startswith("event:"):
                    kind = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    raw = line.split(":", 1)[1].strip()
                    try:
                        events.append((kind, json.loads(raw)))
                    except ValueError:
                        events.append((kind, raw))
        t.join(timeout=5)
        return sid, events


def test_the_cancelled_turn_reports_that_it_was_stopped(client):
    _, events = _run_and_cancel(client)
    done = [d for k, d in events if k == "done"]
    assert done, [k for k, _ in events]
    assert done[-1].get("stopped") is True


def test_the_question_survives_being_stopped(client):
    """The whole bug: reopening the investigation must not find it empty."""
    sid, _ = _run_and_cancel(client)
    msgs = client.get(f"/sessions/{sid}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"], msgs
    assert "why does acme-logs return 403?" in (msgs[0]["content"] or "")


def test_the_partial_answer_survives_being_stopped(client):
    """What the user already read is work, not a draft to discard."""
    sid, _ = _run_and_cancel(client)
    answer = client.get(f"/sessions/{sid}").json()["messages"][-1]["content"] or ""
    assert "Paragraph 0" in answer
    # Partial by definition — a full answer would mean the cancel never landed.
    assert "Paragraph 39" not in answer


def test_the_stop_is_visible_in_the_persisted_answer(client):
    """A truncated answer that does not say it was truncated reads as the whole
    answer, which is worse than losing it."""
    sid, _ = _run_and_cancel(client)
    answer = client.get(f"/sessions/{sid}").json()["messages"][-1]["content"] or ""
    assert "stopped by user" in answer.lower()


def test_cancelling_before_any_text_still_keeps_the_question(client):
    """Stopped almost immediately: there is no answer worth keeping, but the
    question the user typed is theirs and must not vanish."""
    sid, _ = _run_and_cancel(client, cancel_after_s=0.05)
    msgs = client.get(f"/sessions/{sid}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"], msgs
    assert "why does acme-logs return 403?" in (msgs[0]["content"] or "")


def test_the_turn_is_released_so_the_next_one_is_not_queued_behind_it(client):
    sid, _ = _run_and_cancel(client)
    assert client.get(f"/sessions/{sid}/turn").json()["running"] is False


def test_cancelling_an_unknown_turn_is_a_404_not_a_crash(client):
    sid = client.post("/sessions", json={"title": "s"}).json()["id"]
    assert client.post(f"/sessions/{sid}/turns/nope/cancel").status_code == 404


@pytest.mark.parametrize("after", [0.05, 0.3, 0.6, 1.0])
def test_it_holds_wherever_the_stop_lands(client, after):
    """The browser symptom was intermittent, so the timing is the variable."""
    sid, _ = _run_and_cancel(client, cancel_after_s=after)
    msgs = client.get(f"/sessions/{sid}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"], msgs


def test_hanging_up_mid_stream_does_not_throw_the_exchange_away(client):
    """The browser does not just ask the server to stop — it also ABORTS the SSE
    connection. That is the difference between the tests above (which pass) and
    what a user sees, so it gets its own test: read a little, hang up, and check
    the investigation is still there.
    """
    with FakeModel([text_turn(LONG)], delay_s=0.05) as model:
        _provider(client, model)
        sid = client.post("/sessions", json={"title": "acme-logs"}).json()["id"]
        with client.stream("POST", f"/sessions/{sid}/messages/stream",
                           json={"content": "why does acme-logs return 403?",
                                 "turn_id": "turn-1"}) as res:
            assert res.status_code == 200
            seen = 0
            for line in res.iter_lines():
                if (line if isinstance(line, str) else line.decode()).startswith("data:"):
                    seen += 1
                    if seen >= 3:
                        break  # hang up mid-answer, the way the client does
        # Give the worker a moment to finish and persist.
        for _ in range(60):
            msgs = client.get(f"/sessions/{sid}").json()["messages"]
            if msgs:
                break
            time.sleep(0.25)
        assert [m["role"] for m in msgs] == ["user", "assistant"], msgs
        assert "why does acme-logs return 403?" in (msgs[0]["content"] or "")
