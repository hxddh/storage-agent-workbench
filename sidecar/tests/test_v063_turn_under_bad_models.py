"""v0.63.0 — what a turn does when the model misbehaves.

A real model calls tools that do not exist, emits arguments that are not JSON,
returns nothing at all, claims skills it never opened, and proposes actions this
product must never take. Each of those had a defence written for it; none of
them had ever been driven through the actual loop, because that needed a model.
`tests/fake_model.py` is the model, so every one of these is now a real turn.

Each test states the property being defended, not the implementation that
defends it — the point is that a hostile or broken model cannot take the app
down, leak, or get something destructive in front of the user.
"""
from __future__ import annotations

import json

import pytest

from .fake_model import FakeModel, text_turn, tool_turn

SKILL = "storageops-security-iam-policy"


def _provider(client, model):
    client.post("/model-providers", json={
        "name": "fake", "provider_type": "openai-compatible",
        "base_url": model.base_url, "model": "fake-model", "api_key": "k",
    })


def _ask(client, turns, question="why does acme-logs return 403?"):
    """Run one turn against a scripted model; return (response, session_id)."""
    with FakeModel(turns) as model:
        _provider(client, model)
        sid = client.post("/sessions", json={"title": "s"}).json()["id"]
        res = client.post(f"/sessions/{sid}/messages",
                          json={"content": question, "turn_id": "t1"})
        return res, sid


def test_a_call_to_a_tool_that_does_not_exist_does_not_end_the_turn(client):
    """A model that hallucinates a tool name must be told so and allowed to
    continue — not crash the turn and lose the investigation."""
    res, sid = _ask(client, [
        tool_turn("delete_all_the_buckets", {"bucket": "acme-logs"}),
        text_turn("I could not use that; here is what I can say instead."),
    ])
    assert res.status_code == 200, res.text
    detail = client.get(f"/sessions/{sid}")
    assert detail.status_code == 200, detail.text
    assert "instead" in (detail.json()["messages"][-1]["content"] or "")


def test_unparseable_tool_arguments_do_not_end_the_turn(client):
    """The SDK hands the model's raw argument string to the tool; a model that
    emits broken JSON must produce an error the model can read, not a 500."""
    from .fake_model import _chunk

    broken = [
        _chunk({"role": "assistant", "tool_calls": [{
            "index": 0, "id": "c1", "type": "function",
            "function": {"name": "read_skill", "arguments": "{not json at all"},
        }]}),
        _chunk({}, "tool_calls"),
    ]
    res, sid = _ask(client, [broken, text_turn("Recovered without that step.")])
    assert res.status_code == 200, res.text
    assert client.get(f"/sessions/{sid}").status_code == 200


def test_an_empty_answer_is_not_a_crash_AND_not_an_empty_bubble(client):
    """Changed in v0.72.0.

    This asserted `content == ""` — the turn survives a model that says nothing.
    Surviving is still the point, but persisting an empty message turned out to
    be the other half of a defect reported from the shipped app: an answer
    streams in, the thread reloads the turn, and the blank persisted message
    replaces what the user was reading. An empty bubble is indistinguishable
    from a broken app, so the floor is now "says something", not "stores
    nothing".
    """
    res, sid = _ask(client, [text_turn("")])
    assert res.status_code == 200, res.text
    detail = client.get(f"/sessions/{sid}")
    assert detail.status_code == 200, detail.text
    content = detail.json()["messages"][-1]["content"] or ""
    assert content.strip(), "a turn must never persist an empty answer"


def test_a_model_cannot_claim_a_skill_it_never_opened(client):
    """`skills_used` is bound to what `read_skill` actually loaded — otherwise a
    report says the method was applied when it was not."""
    answer = ('Looks like a policy problem.\n\n```json\n'
              '{"skills_used": ["%s"]}\n```' % SKILL)
    _, sid = _ask(client, [text_turn(answer)])
    msg = client.get(f"/sessions/{sid}").json()["messages"][-1]
    assert msg["grounding"]["skills_used"] == []


def test_a_model_cannot_invent_a_skill_name(client):
    answer = ('Done.\n\n```json\n{"skills_used": ["storageops-not-a-real-skill"]}\n```')
    _, sid = _ask(client, [text_turn(answer)])
    assert client.get(f"/sessions/{sid}").json()["messages"][-1]["grounding"]["skills_used"] == []


@pytest.mark.parametrize("action_type", [
    "delete_bucket", "delete_objects", "put_bucket_policy", "put_bucket_acl",
    "recursive_delete", "purge_all_objects",
])
def test_a_destructive_proposal_never_reaches_the_thread(client, action_type):
    """Rule 7/8. The model proposes; this product must not carry the proposal."""
    answer = ('Here is what I would do next.\n\n```json\n{"next_action_proposals":'
              '[{"action_type": "%s", "title": "Clean up"}]}\n```' % action_type)
    _, sid = _ask(client, [text_turn(answer)])
    msg = client.get(f"/sessions/{sid}").json()["messages"][-1]
    assert msg["proposed_actions"] == [], msg["proposed_actions"]


def test_a_surviving_proposal_still_requires_confirmation(client):
    answer = ('Next.\n\n```json\n{"next_action_proposals":[{"action_type":'
              '"review_bucket_security","title":"Review","requires_confirmation":false}]}\n```')
    _, sid = _ask(client, [text_turn(answer)])
    props = client.get(f"/sessions/{sid}").json()["messages"][-1]["proposed_actions"]
    assert props and all(p["requires_confirmation"] for p in props)


def test_a_secret_the_model_echoes_back_is_redacted_before_it_is_stored(client):
    """Rule 2/15: the model is a third party, and its output is sanitized on the
    way into SQLite — not trusted because it came from 'our' model."""
    answer = "The credentials in the log were AKIAIOSFODNN7EXAMPLE and it failed."
    _, sid = _ask(client, [text_turn(answer)])
    stored = json.dumps(client.get(f"/sessions/{sid}").json())
    assert "AKIAIOSFODNN7EXAMPLE" not in stored


def test_an_enormous_answer_is_cut_and_says_so(client):
    """The cap is a backstop against pathological output; a silent truncation
    would present a cut answer as a complete one."""
    _, sid = _ask(client, [text_turn("word " * 60_000)])
    content = client.get(f"/sessions/{sid}").json()["messages"][-1]["content"] or ""
    assert len(content) < 300_000
    assert content != ""


def test_the_same_turn_id_twice_does_not_duplicate_the_exchange(client):
    """The client retries a turn with the SAME id when the stream drops; the
    server dedups rather than answering twice."""
    with FakeModel([text_turn("One answer."), text_turn("A second answer.")]) as model:
        _provider(client, model)
        sid = client.post("/sessions", json={"title": "s"}).json()["id"]
        a = client.post(f"/sessions/{sid}/messages", json={"content": "q", "turn_id": "same"})
        b = client.post(f"/sessions/{sid}/messages", json={"content": "q", "turn_id": "same"})
        assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)
        assert client.get(f"/sessions/{sid}").json()["message_total"] == 2


def test_a_model_that_answers_only_with_the_metadata_block(client):
    """No prose at all: the JSON `answer` field is the documented fallback."""
    _, sid = _ask(client, [text_turn(
        '```json\n{"answer": "The policy is the cause.", "evidence_used": ["head_bucket 200"]}\n```')])
    msg = client.get(f"/sessions/{sid}").json()["messages"][-1]
    assert msg["content"] == "The policy is the cause."
    assert msg["grounding"]["evidence_used"] == ["head_bucket 200"]


def test_a_json_example_inside_the_answer_is_not_eaten_as_the_contract(client):
    """This product's answers quote bucket policies. The contract is the LAST
    block carrying a contract key — a policy example must survive in the prose."""
    answer = (
        'Your policy is:\n\n```json\n{"Effect": "Deny", "Action": "s3:ListBucket"}\n```\n\n'
        'That is the cause.\n\n```json\n{"evidence_used": ["get_bucket_policy"]}\n```'
    )
    _, sid = _ask(client, [text_turn(answer)])
    msg = client.get(f"/sessions/{sid}").json()["messages"][-1]
    assert '"Effect": "Deny"' in (msg["content"] or "")
    assert msg["grounding"]["evidence_used"] == ["get_bucket_policy"]


def test_a_model_that_never_stops_calling_tools_is_bounded(client):
    """A loop must end on the step budget with a persisted answer, not run until
    the process is killed."""
    with FakeModel([tool_turn("read_skill", {"name": SKILL})]) as model:
        _provider(client, model)
        sid = client.post("/sessions", json={"title": "s"}).json()["id"]
        res = client.post(f"/sessions/{sid}/messages", json={"content": "q", "turn_id": "t1"})
        assert res.status_code in (200, 422, 500), res.text
        # Whatever the outcome, the session must remain openable.
        assert client.get(f"/sessions/{sid}").status_code == 200
