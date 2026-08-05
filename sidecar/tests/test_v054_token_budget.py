"""v0.54.0 — bound the turn in the unit that bills, and stop paying twice.

The v0.53.0 round made each individual payload smaller. This round attacks the
three structural reasons a turn was expensive regardless of payload size.

**A — the budget was denominated in the wrong unit.** The only per-turn ceiling
was a CHARACTER budget on cumulative tool output. The SDK re-sends the entire
accumulated conversation on every step, so the same 200k-char budget costs
406k tokens at 10 steps, 781k at 20 and 1.55M at 40 — a linear char budget buys
a quadratic bill, and at ``_MAX_TURNS=60`` one question could legitimately spend
~3.5M tokens with nothing in the product objecting. ``turn_token_budget`` adds
the bound that is actually denominated in what a turn costs, read from the SDK's
live per-run usage; the char budget stays as the fallback for endpoints that
report no usage at all.

**B — every probe cost a full round-trip.** ``parallel_tool_calls`` was off, so
eight independent read-only probes were eight sequential steps, each re-sending
everything before it (measured: ~36% of a realistic 8-tool turn, 71,310 tokens).
It is on now, with per-endpoint capability memory for gateways that mishandle it.
And an identical ``(tool, args)`` call inside one turn is answered from the
conversation instead of re-run: a read-only probe returns the same bytes, and
paying for them again ALSO carries them for every later step.

**C — the same bytes, over and over.** The prompt was ordered so the volatile
thread replay sat in front of the stable skill catalog and provider list,
breaking the provider's cache prefix on every turn; the ``tools_run`` replay
repeated lines already stated in earlier turns (92% verbatim repeats on a real
20-turn session); a list page shipped the same key strings three times; and the
v0.52.0 diagnostic block attached ~500 chars of headers and host id to responses
that SUCCEEDED and needed no diagnosis.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from app.agent_runtime import model_budget
from app.agent_runtime import session_agent as sa
from app.agent_runtime import session_tools
from app.s3 import tools as s3_tools


class _FakeTool:
    """An SDK-shaped tool whose body counts its own invocations."""

    def __init__(self, name: str, ret: str = "payload") -> None:
        self.name = name
        self.calls = 0

        async def inv(ctx, args):  # noqa: ANN001, ANN202
            self.calls += 1
            return ret

        self.on_invoke_tool = inv


def _ctx(input_tokens: int = 0, output_tokens: int = 0):
    return SimpleNamespace(usage=SimpleNamespace(input_tokens=input_tokens,
                                                 output_tokens=output_tokens))


def _invoke(tool, args: str = "{}", ctx=None) -> str:
    return asyncio.run(tool.on_invoke_tool(ctx, args))


# --- A: a budget denominated in tokens ---------------------------------------


def test_the_token_budget_scales_with_the_model_window():
    # The conversation is re-sent on every step, so the honest per-turn ceiling
    # is a multiple of the window, not a constant.
    assert model_budget.turn_token_budget("gpt-4o") == 640_000          # 128k window
    assert model_budget.turn_token_budget("claude-3-5-sonnet") == 1_000_000  # 200k


def test_a_tiny_window_still_gets_a_workable_floor():
    tiny = model_budget.turn_token_budget("unknown-model", 8_000)
    assert tiny == model_budget.TURN_TOKEN_BUDGET_FLOOR


def test_an_enormous_window_is_capped():
    huge = model_budget.turn_token_budget("unknown-model", 10_000_000)
    assert huge == model_budget.TURN_TOKEN_BUDGET_CEILING


def test_an_operator_override_wins_over_the_derived_budget():
    assert model_budget.turn_token_budget("gpt-4o", None, 123_456) == 123_456


def test_a_turn_that_spends_its_tokens_is_asked_to_synthesize():
    t = _FakeTool("list_objects")
    spent = sa._install_tool_output_budget([t], limit=10_000_000, token_limit=50_000)
    assert _invoke(t, '{"a":1}', _ctx(10_000, 500)) == "payload"
    note = json.loads(_invoke(t, '{"a":2}', _ctx(49_000, 2_000)))
    assert note["status"] == "budget_exhausted"
    # Named in the unit that bills, so the model (and the audit trail) can see
    # which bound stopped the investigation.
    assert note["spent_tokens"] == 51_000 and note["budget_tokens"] == 50_000
    assert spent["stopped_on"] == "tokens"
    assert spent["exhausted"] is True


def test_an_endpoint_that_reports_no_usage_falls_back_to_the_char_budget():
    t = _FakeTool("list_objects", "x" * 400)
    spent = sa._install_tool_output_budget([t], limit=500, token_limit=1)
    # ctx=None → no usage object at all. A token_limit of 1 would stop the turn
    # on the FIRST call if absent usage were read as zero-and-under-budget…
    assert _invoke(t, '{"a":1}', None) == "x" * 400
    # …and the char budget is still the real bound on such an endpoint: the
    # second output would overshoot it, the third finds it already spent.
    assert json.loads(_invoke(t, '{"a":2}', None))["status"] == "output_too_large"
    assert json.loads(_invoke(t, '{"a":3}', None))["status"] == "budget_exhausted"
    assert spent["stopped_on"] == "chars"
    assert spent["tokens"] is None


def test_the_turn_reports_the_ceiling_it_ran_under():
    t = _FakeTool("list_objects")
    spent = sa._install_tool_output_budget([t], model="gpt-4o")
    assert spent["token_limit"] == 640_000


# --- B1: parallel tool calls, with capability memory -------------------------


def _built_agent_kwargs(monkeypatch, creds: dict) -> dict:
    """What _make_agent asks the shared builder for, without touching the SDK."""
    from app.agent_runtime import agent_service
    seen: dict = {}
    monkeypatch.setattr(agent_service, "build_agent",
                        lambda *a, **kw: seen.update(kw) or object())
    sa._make_agent(creds, [], "hi", [])
    return seen


def test_parallel_tool_calls_are_requested_by_default(monkeypatch):
    seen = _built_agent_kwargs(monkeypatch,
                               {"base_url": "https://fresh.example", "model": "m1"})
    # Independent probes batch into one step instead of one round-trip each, and
    # every avoided round-trip avoids re-sending the whole conversation.
    assert seen["parallel_tool_calls"] is True


def test_an_endpoint_that_mishandled_them_is_never_asked_again(monkeypatch):
    creds = {"base_url": "https://broken.example", "model": "m2"}
    monkeypatch.setattr(sa, "_NO_PARALLEL_ENDPOINTS", {sa._endpoint_key(creds)})
    # Provider compatibility outranks the saving: one 400 per process, then this
    # endpoint gets sequential calls forever.
    assert _built_agent_kwargs(monkeypatch, creds)["parallel_tool_calls"] is False


def test_the_memory_is_keyed_per_endpoint_not_globally():
    a = sa._endpoint_key({"base_url": "https://a.example", "model": "m"})
    b = sa._endpoint_key({"base_url": "https://b.example", "model": "m"})
    c = sa._endpoint_key({"base_url": "https://a.example", "model": "other"})
    assert len({a, b, c}) == 3


def test_a_sequencing_400_is_recognised_as_the_parallel_symptom():
    exc = Exception("Error code: 400 - An assistant message with 'tool_calls' "
                    "must be followed by tool messages responding to each "
                    "'tool_call_id'")
    assert sa._is_tool_call_sequence_error(exc) is True
    # A different 400 must NOT be attributed to parallel calls, or a real bug
    # silently degrades every later turn on that endpoint.
    assert sa._is_tool_call_sequence_error(Exception("Error code: 400 - bad model")) is False


# --- B2: identical calls inside one turn -------------------------------------


def test_an_identical_call_is_answered_from_the_conversation():
    t = _FakeTool("head_bucket", "200 OK, region us-east-1")
    spent = sa._install_tool_output_budget([t], limit=10_000)
    first = _invoke(t, '{"bucket":"acme"}')
    again = json.loads(_invoke(t, '{"bucket":"acme"}'))
    assert first == "200 OK, region us-east-1"
    assert again["status"] == "repeat_call"
    # It points AT the earlier result rather than pretending the call failed.
    assert "200 OK" in again["result_summary"]
    # And the underlying tool was not re-run — no second S3 request either.
    assert t.calls == 1
    assert spent["deduped"] == 1


def test_different_arguments_are_not_a_repeat():
    t = _FakeTool("head_object", "ok")
    sa._install_tool_output_budget([t], limit=10_000)
    assert _invoke(t, '{"key":"a"}') == "ok"
    assert _invoke(t, '{"key":"b"}') == "ok"
    assert t.calls == 2


def test_a_latency_probe_may_repeat_because_repetition_is_the_measurement():
    t = _FakeTool("measure_request_latency", "p50=41ms")
    sa._install_tool_output_budget([t], limit=10_000)
    assert _invoke(t, '{"bucket":"acme"}') == "p50=41ms"
    # Deduping this would turn a second sample into a copy of the first — a
    # fabricated measurement, which is worse than the tokens it saves.
    assert _invoke(t, '{"bucket":"acme"}') == "p50=41ms"
    assert t.calls == 2


def test_each_wrapper_knows_its_own_tool_name():
    # `t` is the loop variable in the installer; a name read late inside the
    # closure would give every wrapper the LAST tool's name, mis-keying the
    # dedupe map and mis-applying the latency exemption.
    latency = _FakeTool("measure_request_latency", "p50=41ms")
    head = _FakeTool("head_bucket", "200")
    sa._install_tool_output_budget([latency, head], limit=10_000)
    _invoke(head, '{"b":"acme"}')
    assert json.loads(_invoke(head, '{"b":"acme"}'))["status"] == "repeat_call"
    _invoke(latency, '{"b":"acme"}')
    assert _invoke(latency, '{"b":"acme"}') == "p50=41ms"


# --- C: the same bytes, over and over ----------------------------------------


def _thread(turns: int) -> list[dict]:
    out = []
    for i in range(turns):
        out.append({"role": "user", "content": f"question {i}"})
        out.append({"role": "assistant", "content": f"answer {i}", "tool_activity": [
            {"tool": "list_providers", "target": "", "result": "2 providers"},
            {"tool": "head_bucket", "target": "acme-logs", "result": "ok"},
            {"tool": "list_objects", "target": "acme-logs", "result": f"page {i}"},
        ]})
    return out


def test_a_repeated_probe_is_stated_once_across_the_replay():
    msgs = [sa._replay_message(m) for m in _thread(6)]
    sa._dedupe_replay_tools(msgs)
    traces = [m.get("tools_run") or [] for m in msgs if m["role"] == "assistant"]
    heads = [line for tr in traces for line in tr if line.startswith("head_bucket")]
    # Six turns each re-headed the same bucket; the model learns that once.
    assert len(heads) == 1


def test_what_was_dropped_is_counted_not_hidden():
    msgs = [sa._replay_message(m) for m in _thread(3)]
    sa._dedupe_replay_tools(msgs)
    later = [m for m in msgs if m["role"] == "assistant"][-1]["tools_run"]
    # A trace that silently looked shorter than the turn really was would be a
    # lie about what ran.
    assert any(line.startswith("[+") and "repeats" in line for line in later)


def test_the_distinguishing_call_of_each_turn_survives():
    msgs = [sa._replay_message(m) for m in _thread(5)]
    sa._dedupe_replay_tools(msgs)
    kept = [line for m in msgs for line in (m.get("tools_run") or [])]
    for i in range(5):
        assert any(f"page {i}" in line for line in kept)


def test_no_tool_line_is_stated_twice_anywhere_in_the_replay():
    msgs = [sa._replay_message(m) for m in _thread(20)]
    sa._dedupe_replay_tools(msgs)
    lines = [ln for m in msgs for ln in (m.get("tools_run") or [])
             if not ln.startswith("[+")]
    assert len(lines) == len(set(lines))


def test_the_replay_shrinks_measurably():
    msgs = [sa._replay_message(m) for m in _thread(20)]
    before = len(json.dumps(msgs, separators=(",", ":")))
    tool_chars_before = sum(len(ln) for m in msgs for ln in (m.get("tools_run") or []))
    sa._dedupe_replay_tools(msgs)
    after = len(json.dumps(msgs, separators=(",", ":")))
    tool_chars_after = sum(len(ln) for m in msgs for ln in (m.get("tools_run") or []))
    # The trace itself roughly halves; the whole replay (which also carries the
    # message bodies the dedupe never touches) shrinks by ~14%.
    assert tool_chars_after < tool_chars_before * 0.60, \
        f"{tool_chars_before} -> {tool_chars_after}"
    assert after < before * 0.90, f"{before} -> {after}"


def test_the_stable_half_of_the_context_comes_first():
    ctx = sa.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": [{"text": "f"}], "findings": [], "open_questions": [],
         "limitations": []},
        _thread(3), [{"kind": "fact", "text": "m"}])
    stable, volatile = sa.split_context_for_cache(ctx)
    assert set(stable) == {"session", "summary", "agent_memory"}
    assert set(volatile) == {"recent_messages"}
    # Nothing is lost in the split — the two halves are the whole context.
    assert {**stable, **volatile} == ctx


def test_the_cacheable_prefix_survives_a_new_message():
    summary = {"known_facts": [{"text": "f" * 200}], "findings": [],
               "open_questions": [], "limitations": []}
    session = {"title": "t", "goal": "g", "status": "active"}
    memory = [{"kind": "fact", "text": "m" * 200}]

    def stable_text(turns: int) -> str:
        ctx = sa.build_session_context(session, summary, _thread(turns), memory)
        return sa.render_context_text(sa.split_context_for_cache(ctx)[0])

    # A provider's prompt cache matches on the PREFIX and stops at the first
    # differing byte. The stable half must be byte-identical between turns, or
    # everything after it is re-billed at full price.
    assert stable_text(3) == stable_text(4)


def test_a_list_page_ships_each_key_once():
    keys = [f"logs/2026/08/{i:04d}.log" for i in range(200)]
    page = {"success": True, "keys": keys, "sample_keys": keys[:20],
            "objects": [{"key": k, "size": 10, "storage_class": "STANDARD"}
                        for k in keys[:100]]}
    out = session_tools._compact_list_page(page)
    assert "sample_keys" not in out
    assert all("key" not in o for o in out["objects"])
    # The alignment that replaces the repeated key is stated in the payload, not
    # left for the model to infer.
    assert out["objects_align_with_keys"] is True
    assert out["keys"] == keys  # the enumeration surface is untouched


def test_an_unexpected_page_shape_is_left_alone():
    # Defensive: if `objects` ever stops mirroring `keys`, dropping the key
    # field would silently mis-attribute every size to the wrong object.
    page = {"keys": ["a", "b"], "sample_keys": ["a"],
            "objects": [{"key": "z", "size": 1}]}
    out = session_tools._compact_list_page(dict(page))
    assert out["objects"] == [{"key": "z", "size": 1}]
    assert "objects_align_with_keys" not in out


def test_a_successful_call_carries_no_diagnostic_padding():
    meta = {"RequestId": "R1", "HostId": "H" * 100, "RetryAttempts": 0,
            "HTTPHeaders": {"server": "AmazonS3", "content-type": "application/xml",
                            "date": "Wed, 05 Aug 2026 04:00:00 GMT"}}
    ok = s3_tools._diag_meta(meta, verbose=False)
    # A 200 needs no diagnosis: the ~100-char opaque host id and the header dump
    # are escalation material for a FAILURE.
    assert ok == {"request_id": "R1"}


def test_a_silently_retried_success_still_explains_itself():
    meta = {"RequestId": "R1", "RetryAttempts": 3, "HTTPHeaders": {}}
    ok = s3_tools._diag_meta(meta, verbose=False)
    # This is why an apparently fine call took four seconds — dropping it would
    # make throttling invisible.
    assert ok["retry_attempts"] == 3


def test_a_redirect_region_survives_the_compact_shape():
    meta = {"RequestId": "R1", "HTTPHeaders": {"x-amz-bucket-region": "us-west-2"}}
    assert s3_tools._diag_meta(meta, verbose=False)["bucket_region"] == "us-west-2"


def test_a_failure_still_carries_everything():
    meta = {"RequestId": "R1", "HostId": "H1", "RetryAttempts": 2,
            "HTTPHeaders": {"server": "AmazonS3"}}
    bad = s3_tools._diag_meta(meta)
    assert bad["host_id"] == "H1" and bad["retry_attempts"] == 2
    assert bad["headers_sanitized"]["server"] == "AmazonS3"
