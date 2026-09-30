"""v10 — the runtime budget for a 16k-window local model.

Pins: one budget plan (window, max_tokens, input budget) and one char→token
estimate; ~2 048 completion tokens for windows ≤ 32k; compaction against the
input budget, also with fewer than three earlier Turns; in-turn pressure that
shrinks earlier tool outputs (enveloped previews) and keeps the latest whole;
side steps fitted to the window they protect, and a clear failure when even the
fallback answer fails; steers kept across the websocket→HTTP retry; Ollama asked
for the planned window.
"""

from __future__ import annotations

import asyncio
import json
import time

from app.agent import budget, errors, models, prompt, runtime, safety
from app.agent import tools as _tools  # noqa: F401
from app.agent.session import fit, input_chars, preview_output, shrink_outputs
from app.agent.tools import registry
from tests.fake_model import FakeModel, text_turn, tool_turn


def _use(client, fake: FakeModel, **extra) -> str:
    return client.post("/providers/models", json={"name": "fake", "kind": "openai-compatible",
                                                   "base_url": fake.base_url, "model": "fake-model",
                                                   **extra}).json()["id"]


def _settle(client, task_id: str, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/tasks/{task_id}").json()
        if snap["state"] not in ("working", "queued"):
            return snap
        time.sleep(0.05)
    raise AssertionError(f"task still {snap['state']}")


def _start(client, direction: str) -> str:
    return client.post("/tasks", json={"direction": direction}).json()["task"]["id"]


def _events(snap: dict) -> list[str]:
    return [i["payload"]["event"] for i in snap["items"] if i["type"] == "notice"]


def _request_chars(req: dict) -> int:
    """Model-facing characters of one Chat Completions request: every message's
    text, tool-call arguments, and the tool definitions."""
    n = len(json.dumps(req.get("tools") or []))
    for m in req.get("messages") or []:
        c = m.get("content")
        n += len(c) if isinstance(c, str) else len(json.dumps(c or ""))
        n += sum(len(tc["function"]["arguments"]) + len(tc["function"]["name"]) for tc in m.get("tool_calls") or [])
    return n


def _big_tool(monkeypatch, size: int, calls: list | None = None):
    """``list_uploaded_files`` returning ``size`` chars for any ``n`` — outputs
    that cross a small window in a few calls."""
    td = registry.REGISTRY["list_uploaded_files"]

    def list_uploaded_files(n: int = 0) -> dict:
        """List files."""
        if calls is not None:
            calls.append(n)
        return {"success": True, "datasets": [], "n": n, "blob": "x" * size}

    monkeypatch.setattr(td, "fn", list_uploaded_files)


# --- the budget --------------------------------------------------------------------------


def test_small_windows_reserve_about_2048_completion_tokens():
    assert budget.completion_token_budget(None, 8_192) == 2_048
    assert budget.completion_token_budget(None, 16_384) == 2_048
    assert budget.completion_token_budget(None, 32_768) == 2_048
    assert budget.completion_token_budget(None, 4_096) == 1_024  # never above a quarter of a tiny window
    assert budget.completion_token_budget("gpt-3.5-turbo", 16_385) == 2_048
    # Above 32k: unchanged (window//8 floored at 16 384, never above the model's max output).
    assert budget.completion_token_budget(None, 128_000) == 16_384
    assert budget.completion_token_budget(None, 400_000) == 16_384
    assert budget.completion_token_budget("o3", 200_000) == 25_000
    assert budget.completion_token_budget("gpt-4-turbo", 128_000) == 4_096
    assert budget.completion_token_budget(None, 16_384, explicit_max=1_000) == 1_000


def test_one_plan_decides_window_and_max_tokens():
    local = budget.plan({"kind": "ollama", "base_url": "http://127.0.0.1:11434/v1", "model": "llama3.1:8b"})
    assert (local.window, local.max_tokens, local.input_tokens) == (16_384, 2_048, 14_336)
    assert local.input_chars == int(14_336 * budget.CHARS_PER_TOKEN)
    hosted = budget.plan({"kind": "deepseek", "model": "deepseek-chat"})
    assert hosted.window == 128_000 and hosted.max_tokens == 8_192
    declared = budget.plan({"kind": "vllm", "model": "qwen3:8b", "context_window": 40_960})
    assert declared.window == 40_960
    # The resolved credentials and the plan agree (one source of truth).
    assert budget.planned_window("ollama", None, "x", None) == budget.LOCAL_DEFAULT_WINDOW
    assert budget.est_tokens(3_200) == 1_000 and budget.est_tokens(3_201) == 1_001


def test_every_request_asks_for_the_planned_max_tokens(client):
    with FakeModel([text_turn("ok")]) as fake:
        _use(client, fake)
        _settle(client, _start(client, "Hi"))
    assert fake.requests[0]["max_tokens"] == 2_048


def test_ollama_is_asked_for_the_planned_window():
    clients: list = []
    _, settings = models.build({"kind": "ollama", "base_url": "http://127.0.0.1:11434/v1", "model": "qwen3:8b",
                                "api_key": "not-needed", "api_style": "chat", "context_window": 16_384}, clients)
    asyncio.run(models.close_clients(clients))
    assert settings.extra_body == {"options": {"num_ctx": 16_384}}
    assert settings.max_tokens == 2_048
    _, other = models.build({"kind": "vllm", "base_url": "http://x/v1", "model": "m", "api_key": "k",
                             "api_style": "chat"}, [])
    assert other.extra_body is None


def test_the_sdk_sends_extra_body_to_chat_completions():
    """The installed openai-agents passes ModelSettings.extra_body through to the
    Chat Completions request body (what makes num_ctx reach Ollama)."""
    import inspect

    from agents.models import openai_chatcompletions
    assert "extra_body" in inspect.getsource(openai_chatcompletions)


# --- in-turn pressure ----------------------------------------------------------------------


def test_preview_keeps_the_envelope_closed():
    text = safety.envelope('{"a": "' + "y" * 5000 + '"}')
    small = preview_output(text, 100)
    assert small.startswith("[earlier output trimmed: ") and small.endswith("]")
    assert safety.UNTRUSTED_OPEN in small and safety.UNTRUSTED_CLOSE in small and len(small) < 300


def test_shrink_keeps_the_latest_batch_whole():
    items = [{"role": "user", "content": "q"}]
    for n in range(3):
        items += [{"type": "function_call", "call_id": f"c{n}", "name": "t", "arguments": "{}"},
                  {"type": "function_call_output", "call_id": f"c{n}", "output": "z" * 10_000}]
    out, shrunk = shrink_outputs(items, 15_000)
    assert shrunk == 2 and out[-1]["output"] == "z" * 10_000
    assert all(o["output"].startswith("[earlier output trimmed") for o in (out[2], out[4]))
    assert input_chars(out) <= 15_000
    same, none = shrink_outputs(items, 10**6)
    assert none == 0 and same is items


def test_a_long_turn_shrinks_its_earlier_outputs_not_the_latest(client, monkeypatch):
    _big_tool(monkeypatch, 12_500)
    with FakeModel([tool_turn("list_uploaded_files", {"n": 1}), tool_turn("list_uploaded_files", {"n": 2}),
                    tool_turn("list_uploaded_files", {"n": 3}), text_turn("Done.")]) as fake:
        _use(client, fake)  # a local endpoint: planned as 16k
        snap = _settle(client, _start(client, "Look at everything"))
    assert snap["turns"][0]["status"] == "completed"
    last = [m["content"] for m in fake.requests[-1]["messages"] if m.get("role") == "tool"]
    assert len(last) == 3
    assert last[0].startswith("[earlier output trimmed: ") and last[1].startswith("[earlier output trimmed: ")
    assert safety.UNTRUSTED_CLOSE in last[0]
    assert '"n":3' in last[2] and not last[2].startswith("[earlier")
    plan = budget.plan({"kind": "openai-compatible", "base_url": fake.base_url, "model": "fake-model"})
    for req in fake.requests:
        assert budget.est_tokens(_request_chars(req)) + req["max_tokens"] <= plan.window, _request_chars(req)
    # The durable record keeps every output whole: only model input shrinks.
    outs = [i for i in snap["items"] if i["type"] == "tool_output"]
    assert all(len(o["payload"]["detail"]) > 12_000 for o in outs)


# --- compaction ------------------------------------------------------------------------------


def test_one_earlier_turn_is_folded_when_it_alone_overflows(client):
    huge = "Bucket finding line. " * 3_000  # ≈ 63 000 chars: over a 16k window by itself
    with FakeModel([text_turn(huge), text_turn("Second answer.")], compaction="- Earlier: one huge answer.") as fake:
        _use(client, fake)
        tid = _start(client, "Q1")
        _settle(client, tid)
        client.post(f"/tasks/{tid}/turns", json={"direction": "Q2"})
        snap = _settle(client, tid)
    assert len(fake.compaction_requests) == 1
    assert "compacted" in _events(snap)
    last = json.dumps(fake.requests[-1]["messages"])
    assert "one huge answer" in last and "Bucket finding line." not in last and "Q2" in last
    # The summarizer itself read a history fitted to the window it protects.
    plan = budget.plan({"kind": "openai-compatible", "base_url": fake.base_url, "model": "fake-model"})
    summ = fake.compaction_requests[0]
    assert budget.est_tokens(_request_chars(summ)) + summ["max_tokens"] <= plan.window
    comp = next(i for i in snap["items"] if i["type"] == "compaction")
    assert comp["payload"]["turns_folded"] == 1 and comp["turn_id"] == snap["turns"][-1]["id"]


def test_needs_compaction_uses_the_input_budget():
    plan = budget.plan({"kind": "ollama", "model": "x"})
    edge = int(plan.input_tokens * 0.8 * budget.CHARS_PER_TOKEN)
    assert runtime.needs_compaction(edge, 0, plan.input_tokens)
    assert not runtime.needs_compaction(edge - 400, 0, plan.input_tokens)


# --- side steps ---------------------------------------------------------------------------------


def test_fit_drops_oldest_whole_units_and_says_so():
    items = [{"role": "user", "content": "a" * 5_000}, {"type": "function_call", "call_id": "c", "name": "t",
                                                          "arguments": "{}"},
             {"type": "function_call_output", "call_id": "c", "output": "b" * 5_000},
             {"role": "user", "content": "latest question"}]
    out = fit(items, 2_000)
    assert input_chars(out) <= 2_000
    assert out[0]["content"].startswith("[Earlier history omitted")
    assert out[-1]["content"] == "latest question"
    assert not any(i.get("type") == "function_call_output" for i in out[1:2])


def test_the_fallback_answer_reads_a_fitted_history(client):
    huge = "Earlier answer line. " * 3_000
    with FakeModel([text_turn(huge), text_turn("never")], compaction="",  # the summary fails: nothing folds
                   fail=[(400, "This model's maximum context length is 16384 tokens (context_length_exceeded)")],
                   fail_at=1, finalize="Here is what the work supports.") as fake:
        _use(client, fake)
        tid = _start(client, "Q1")
        _settle(client, tid)
        client.post(f"/tasks/{tid}/turns", json={"direction": "Q2"})
        snap = _settle(client, tid)
    assert snap["turns"][-1]["status"] == "completed"
    assert "finalized" in _events(snap)
    fin = fake.finalize_requests[-1]
    plan = budget.plan({"kind": "openai-compatible", "base_url": fake.base_url, "model": "fake-model"})
    assert budget.est_tokens(_request_chars(fin)) + fin["max_tokens"] <= plan.window
    assert "Q2" in json.dumps(fin["messages"]) and "Earlier history omitted" in json.dumps(fin["messages"])


def test_a_failed_fallback_is_a_clear_failure_not_a_canned_answer(client):
    with FakeModel([text_turn("never")], fail=[(400, "context_length_exceeded: prompt is too long")],
                   finalize_status=500) as fake:
        _use(client, fake)
        snap = _settle(client, _start(client, "Q"))
    turn = snap["turns"][-1]
    assert turn["status"] == "failed" and "could not write an answer" in (turn["error"] or "")
    assert any(i["type"] == "error" and "could not write an answer" in i["payload"]["message"]
               for i in snap["items"])
    assert not any(i["type"] == "agent_message" for i in snap["items"])
    assert fake.finalize_requests


# --- websocket fallback keeps steers -------------------------------------------------------------


def test_steers_survive_the_transport_retry(client, monkeypatch):
    monkeypatch.setattr(errors, "is_websocket_failure", lambda exc: "wsrefused" in str(exc))

    async def steer_first(self, conn, task_id, turn_id, creds, rec, clients):
        self.steer(conn, task_id, "Focus on the logs bucket")

    monkeypatch.setattr(runtime.Runtime, "_maybe_compact", steer_first)
    with FakeModel([text_turn("Looked at logs.")], fail=[(400, "wsrefused: upgrade failed")]) as fake:
        _use(client, fake)
        snap = _settle(client, _start(client, "Check my storage"))
    assert snap["turns"][0]["status"] == "completed"
    assert len(fake.requests) == 2  # the refused attempt, then the retry
    for req in fake.requests:
        steers = [m for m in req["messages"] if "Focus on the logs bucket" in str(m.get("content"))]
        assert len(steers) == 1, req["messages"]
    assert [i["type"] for i in snap["items"]].count("steer") == 1


def test_steers_keep_their_order_at_one_position(client, monkeypatch):
    async def two_steers(self, conn, task_id, turn_id, creds, rec, clients):
        self.steer(conn, task_id, "first steer")
        self.steer(conn, task_id, "second steer")

    monkeypatch.setattr(runtime.Runtime, "_maybe_compact", two_steers)
    with FakeModel([text_turn("ok")]) as fake:
        _use(client, fake)
        _settle(client, _start(client, "Go"))
    text = json.dumps(fake.requests[0]["messages"])
    assert text.index("first steer") < text.index("second steer")


def test_the_first_request_leaves_room_to_answer_in_small_windows(client):
    """Request 0 of a first survey (Chat Completions, one storage account, the
    real registry and prompt) + max_tokens fits a 16k and a 32k window, measured
    with the conservative estimate. Measured at v10: 21 397 chars (tools 16 576,
    instructions 4 796) ≈ 6 687 tokens + 2 048 = 8 735 — 53 % of 16k. An 8k
    window needs the smaller tool set (≈ 10k chars of schemas: ≈ 6 700)."""
    client.post("/providers/clouds", json={
        "name": "demo", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"})
    sizes = {}
    for window in (16_384, 32_768):
        with FakeModel([text_turn("ok")]) as fake:
            pid = _use(client, fake, context_window=window)
            client.post(f"/providers/models/{pid}/activate")
            _settle(client, _start(client, "Survey my storage account"))
        req = fake.requests[0]
        est = budget.est_tokens(_request_chars(req))
        sizes[window] = (est, req["max_tokens"])
        assert req["max_tokens"] == 2_048
        assert est + req["max_tokens"] <= window * 0.75, (window, est)
    # The prefix a Turn plans with (instructions + schemas) matches what was sent.
    assert registry.schema_chars(responses=False) <= len(json.dumps(req["tools"])) + 200
    assert len(prompt.INSTRUCTIONS) < 5_200
