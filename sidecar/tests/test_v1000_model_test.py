"""v10 — the model Test says whether the model can call tools.

Reachability first (as before); then one tiny chat call with one trivial tool,
bounded, reporting whether a structured tool call came back; for Ollama, the
model's context length from /api/show against the planned window. The key is
never echoed.
"""

from __future__ import annotations

from tests.fake_model import FakeModel, text_turn, tool_turn

KEY = "sk-test-SECRETVALUE-0123456789abcdef"


def _model(client, fake: FakeModel, kind: str = "openai-compatible", **extra) -> str:
    return client.post("/providers/models", json={"name": "m", "kind": kind, "base_url": fake.base_url,
                                                   "model": "fake-model", "api_key": KEY, **extra}).json()["id"]


def test_a_structured_tool_call_is_reported(client):
    with FakeModel([tool_turn("report_ready", {"ready": True})]) as fake:
        body = client.post(f"/providers/models/{_model(client, fake)}/test").json()
    assert body["ok"] is True and body["tool_calling"] is True
    assert "Tool calling works" in body["detail"] and body["planned_window"] == 16_384
    req = fake.requests[0]
    assert [t["function"]["name"] for t in req["tools"]] == ["report_ready"] and req["max_tokens"] <= 128
    assert KEY not in str(body)


def test_a_text_answer_is_reported_as_no_tool_calling(client):
    with FakeModel([text_turn('{"name": "report_ready", "arguments": {"ready": true}}')]) as fake:
        body = client.post(f"/providers/models/{_model(client, fake)}/test").json()
    assert body["ok"] is True and body["tool_calling"] is False
    assert "instead of a structured tool call" in body["detail"]


def test_a_failed_check_is_reported_without_the_body_or_key(client):
    with FakeModel([text_turn("x")], fail=[(400, "bad things happened")]) as fake:
        body = client.post(f"/providers/models/{_model(client, fake)}/test").json()
    assert body["ok"] is True and body["tool_calling"] is None
    assert "tool-call check failed" in body["detail"] and KEY not in str(body)


def test_ollama_reports_a_context_smaller_than_planned(client):
    show = {"model_info": {"general.architecture": "x", "x.context_length": 8192}}
    with FakeModel([tool_turn("report_ready", {"ready": True})], show=show) as fake:
        body = client.post(f"/providers/models/{_model(client, fake, kind='ollama')}/test").json()
    assert body["model_context"] == 8192 and body["planned_window"] == 16_384
    assert "set its context window to 8,192" in body["detail"]
    assert fake.show_requests and fake.show_requests[0]["model"] == "fake-model"
    # The check itself asks for the window the Agent will use.
    assert fake.requests[0]["options"] == {"num_ctx": 16_384}


def test_ollama_without_api_show_still_tests(client):
    with FakeModel([tool_turn("report_ready", {"ready": True})]) as fake:
        body = client.post(f"/providers/models/{_model(client, fake, kind='ollama', context_window=8192)}/test").json()
    assert body["model_context"] is None and body["tool_calling"] is True and body["planned_window"] == 8192
    assert "context window to" not in body["detail"]
