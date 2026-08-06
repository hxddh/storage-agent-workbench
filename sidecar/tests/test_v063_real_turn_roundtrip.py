"""v0.63.0 — one real agent turn, then open the session.

This is the test whose absence let a 500 on `GET /sessions/{id}` ship. The
sequence it covers is the product's core loop and nothing else covered it
end-to-end:

    ask -> the SDK runs -> a tool executes -> `note()` records the call ->
    the contract is parsed -> user+assistant are persisted -> the thread is read

Every other session test stubs `SESSION_LOOP` or asserts on a stage in
isolation, because running the loop needed a model and a model needed an API
key. `tests/fake_model.py` removes that constraint: `build_agent` puts the
provider's `base_url` on a per-session client and speaks `/chat/completions`, so
a local socket that speaks it is a model as far as this app is concerned.

`read_skill` is the tool the script calls: it is real, it is in the whitelist, it
records a normal activity row, and it touches no cloud provider and no
credential — so the turn exercises the writer without needing an S3 endpoint.
"""
from __future__ import annotations

import json

import pytest

from .fake_model import FakeModel, text_turn, tool_turn

SKILL = "storageops-security-iam-policy"

ANSWER = """The bucket policy omits s3:ListBucket for that principal.

```json
{"skills_used": ["%s"],
 "evidence_used": ["read_skill returned the IAM policy method"],
 "evidence_gaps": ["no live bucket was reachable"],
 "next_action_proposals": [{"action_type": "review_bucket_security",
                            "title": "Review the bucket's security posture"}]}
```
""" % SKILL

@pytest.fixture
def turned(client):
    """Run one real turn against a scripted model; yield (client, session_id)."""
    with FakeModel([tool_turn("read_skill", {"name": SKILL}), text_turn(ANSWER)]) as model:
        created = client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible",
            "base_url": model.base_url, "model": "fake-model", "api_key": "not-a-real-key",
        })
        assert created.status_code in (200, 201), created.text
        sid = client.post("/sessions", json={"title": "403 on acme-logs"}).json()["id"]
        res = client.post(f"/sessions/{sid}/messages",
                          json={"content": "why does acme-logs return 403 on list?",
                                "turn_id": "turn-1"})
        assert res.status_code == 200, res.text
        yield client, sid, res.json(), model


def test_the_session_opens_after_a_turn_that_called_a_tool(turned):
    """The whole regression, through the real writer rather than a fixture."""
    client, sid, _, _ = turned
    assert client.get(f"/sessions/{sid}").status_code == 200


def test_the_turn_persisted_both_halves_of_the_exchange(turned):
    client, sid, _, _ = turned
    msgs = client.get(f"/sessions/{sid}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert "acme-logs" in (msgs[0]["content"] or "")
    assert "s3:ListBucket" in (msgs[1]["content"] or "")


def test_the_contract_block_is_not_left_in_the_answer(turned):
    """The metadata block is machine-readable bookkeeping; a reader must never
    see it in the prose."""
    client, sid, _, _ = turned
    answer = client.get(f"/sessions/{sid}").json()["messages"][-1]["content"] or ""
    assert "next_action_proposals" not in answer


def test_the_tool_call_reaches_the_thread_with_its_real_types(turned):
    """`duration_ms` is a measurement and `ok` a verdict — the exact fields the
    response model used to reject."""
    client, sid, _, _ = turned
    row = client.get(f"/sessions/{sid}").json()["messages"][-1]["tool_activity"][0]
    assert row["tool"] == "read_skill"
    assert row["ok"] is True
    assert isinstance(row["duration_ms"], int)
    assert row["status"] == "completed"


def test_the_same_call_is_readable_on_its_own(turned):
    """The id the thread row carries must resolve to the persisted `tool_calls`
    row — that is what makes a trace row expandable in place."""
    client, sid, _, _ = turned
    row = client.get(f"/sessions/{sid}").json()["messages"][-1]["tool_activity"][0]
    detail = client.get(f"/sessions/{sid}/activity/{row['id']}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["tool_name"] == "read_skill"


def test_grounding_and_proposals_survive_the_reload(turned):
    """Persisted per-message so a reopened thread re-renders them (migration 016)."""
    client, sid, _, _ = turned
    msg = client.get(f"/sessions/{sid}").json()["messages"][-1]
    assert msg["grounding"]["skills_used"] == [SKILL]
    assert msg["grounding"]["evidence_gaps"] == ["no live bucket was reachable"]
    assert [p["action_type"] for p in msg["proposed_actions"]] == ["review_bucket_security"]
    # Never auto-executed, whatever the model asked for.
    assert all(p["requires_confirmation"] for p in msg["proposed_actions"])


def test_the_turn_is_measured_and_the_measurement_is_readable(turned):
    client, sid, _, _ = turned
    mid = client.get(f"/sessions/{sid}").json()["messages"][-1]["id"]
    turns = client.get(f"/sessions/{sid}/overview").json()["turns"]
    row = next(t for t in turns if t["message_id"] == mid)
    assert row["tool_calls"] == 1
    assert row["duration_ms"] > 0


def test_the_call_is_in_the_audit_trail(turned):
    """Rule 17: every tool call is recorded."""
    client, sid, _, _ = turned
    items = client.get(f"/sessions/{sid}/audit").json()["items"]
    blob = json.dumps(items)
    assert "read_skill" in blob, [i["event_type"] for i in items]


def test_no_credential_value_is_sent_to_the_model(client):
    """Rule 1, checked against the bytes that actually went over the socket.

    Asserting on credential-shaped WORDS would fail on the instructions
    themselves, which name `Authorization` and `api_key` precisely to tell the
    model never to echo them. What must never appear is a VALUE — so this
    configures a cloud provider with recognizable secrets first, and looks for
    those.
    """
    with FakeModel([tool_turn("read_skill", {"name": SKILL}), text_turn(ANSWER)]) as model:
        client.post("/cloud-providers", json={
            "name": "acme", "provider_type": "s3",
            "endpoint_url": "https://s3.example.invalid", "region": "us-east-1",
            "access_key": "AKIAUNIQUEPROBE0001",
            "secret_key": "secretprobe/UNIQUE0002",
            "session_token": "tokenprobe-UNIQUE0003",
        })
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible",
            "base_url": model.base_url, "model": "fake-model",
            "api_key": "modelkeyprobe-UNIQUE0004",
        })
        sid = client.post("/sessions", json={"title": "s"}).json()["id"]
        assert client.post(f"/sessions/{sid}/messages",
                           json={"content": "check acme-logs", "turn_id": "t1"}).status_code == 200

        body = json.dumps(model.requests)
        for probe in ("AKIAUNIQUEPROBE0001", "secretprobe/UNIQUE0002",
                      "tokenprobe-UNIQUE0003", "modelkeyprobe-UNIQUE0004"):
            assert probe not in body, probe

        # Nor into anything the turn persisted (rules 2 and 15).
        stored = json.dumps(client.get(f"/sessions/{sid}").json())
        stored += json.dumps(client.get(f"/sessions/{sid}/audit").json())
        stored += json.dumps(client.get(f"/sessions/{sid}/activity").json())
        for probe in ("AKIAUNIQUEPROBE0001", "secretprobe/UNIQUE0002",
                      "tokenprobe-UNIQUE0003", "modelkeyprobe-UNIQUE0004"):
            assert probe not in stored, probe


def test_a_second_turn_appends_rather_than_replacing(client):
    """Two turns in one session: the first exchange must still be there. This is
    the shape the released app failed at, and the reason is that the second turn
    reads the thread before it writes."""
    with FakeModel([
        tool_turn("read_skill", {"name": SKILL}), text_turn(ANSWER),
        text_turn("Second answer: the ACL is not involved."),
    ]) as model:
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible",
            "base_url": model.base_url, "model": "fake-model", "api_key": "k",
        })
        sid = client.post("/sessions", json={"title": "s"}).json()["id"]
        assert client.post(f"/sessions/{sid}/messages",
                           json={"content": "first question", "turn_id": "t1"}).status_code == 200
        assert client.post(f"/sessions/{sid}/messages",
                           json={"content": "second question", "turn_id": "t2"}).status_code == 200

        detail = client.get(f"/sessions/{sid}")
        assert detail.status_code == 200, detail.text
        contents = [m["content"] for m in detail.json()["messages"]]
        assert "first question" in contents
        assert "second question" in contents
        assert detail.json()["message_total"] == 4
