"""Graceful step-budget (max_turns) handling.

When the agent exhausts its turn budget the run must NOT surface a hard error.
The streaming path flushes the tool trace, runs a tool-less finalize to
synthesize a grounded answer, and ends with a normal 'final' — so the client
never sees a max-turns error (and never double-runs via the blocking fallback).
"""

import asyncio

from app.agent_runtime import session_agent


def test_is_max_turns_detection():
    assert session_agent._is_max_turns(Exception("Max turns (16) exceeded"))
    assert session_agent._is_max_turns(type("MaxTurnsExceeded", (Exception,), {})())
    assert not session_agent._is_max_turns(Exception("connection reset"))


def test_finalize_directive_includes_trace_and_no_more_tools():
    d = session_agent._finalize_directive([{"tool": "head_bucket", "target": "b", "result": "ok"}])
    assert "do NOT" in d and "head_bucket" in d
    # empty trace still produces a safe directive
    assert "no tool calls" in session_agent._finalize_directive([]).lower()


def test_stream_finalizes_on_max_turns_instead_of_erroring():
    class FakeResult:
        final_output = ""

        async def stream_events(self):
            raise Exception("Max turns (16) exceeded")
            yield  # noqa: unreachable — makes this an async generator

    async def finalize():
        return "Based on the investigation so far, the bucket looks reachable."

    async def collect():
        out = []
        async for kind, data in session_agent.stream_events_for(FakeResult(), [], [], finalize):
            out.append((kind, data))
        return out

    events = asyncio.run(collect())
    kinds = [k for k, _ in events]
    # No exception propagated, and the run ends with a normal 'final'.
    assert "final" in kinds
    # The finalize answer is streamed as a delta AND carried into the contract.
    assert any(k == "delta" and "investigation so far" in d for k, d in events)
    final = next(d for k, d in events if k == "final")
    assert "investigation so far" in (final.get("answer") or "")


def test_stream_reraises_non_maxturns_errors():
    class FakeResult:
        final_output = ""

        async def stream_events(self):
            raise RuntimeError("connection reset by peer")
            yield

    async def finalize():
        return "should not be called"

    async def collect():
        async for _ in session_agent.stream_events_for(FakeResult(), [], [], finalize):
            pass

    # A genuine transport error is NOT swallowed — it still propagates so the
    # client can fall back to the blocking turn.
    try:
        asyncio.run(collect())
        assert False, "expected the transport error to propagate"
    except RuntimeError as e:
        assert "connection reset" in str(e)


# --- v0.24.18: transient provider errors + tool-output-budget cut-short ------


def test_transient_provider_error_detection():
    # Rate limit / 5xx by status code, type name, or "Error code: N" text.
    assert session_agent._is_transient_provider_error(
        type("RateLimitError", (Exception,), {"status_code": 429})("slow down"))
    assert session_agent._is_transient_provider_error(Exception("Error code: 503 - upstream"))
    assert session_agent._is_transient_provider_error(
        type("InternalServerError", (Exception,), {})("boom"))
    # A bare connection reset (no HTTP status) is NOT transient here — it goes to
    # the fallback re-run path, so it must still propagate.
    assert not session_agent._is_transient_provider_error(RuntimeError("connection reset by peer"))
    # A deterministic client error is never transient.
    assert not session_agent._is_transient_provider_error(
        type("BadRequestError", (Exception,), {"status_code": 400})("bad"))


def test_stream_finalizes_on_transient_error_with_continue_proposal():
    class FakeResult:
        final_output = ""

        async def stream_events(self):
            raise type("RateLimitError", (Exception,), {"status_code": 429})("rate limited")
            yield  # noqa: unreachable

    async def finalize():
        return "The bucket is reachable based on the checks completed so far."

    async def collect():
        out = []
        async for kind, data in session_agent.stream_events_for(FakeResult(), [], [], finalize):
            out.append((kind, data))
        return out

    events = asyncio.run(collect())
    final = next(d for k, d in events if k == "final")
    # Grounded answer synthesized from the trace, marked as a transient interruption.
    assert "reachable" in (final.get("answer") or "")
    assert "temporary provider error" in (final.get("answer") or "")
    # And a one-click continue proposal is offered.
    assert any(p.get("action_type") == session_agent._CONTINUE_ACTION
               for p in final.get("next_action_proposals") or [])


def test_tool_output_budget_note_is_status_not_error():
    # The exhausted note reads as a soft boundary with a next step, not a failure.
    import json

    calls = {"n": 0}

    class FakeTool:
        name = "list_objects"

        async def on_invoke_tool(self, ctx, args):
            calls["n"] += 1
            return "x" * 100

    tool = FakeTool()
    budget = session_agent._install_tool_output_budget([tool], limit=10)

    async def run():
        first = await tool.on_invoke_tool(None, None)   # consumes >10 chars
        second = await tool.on_invoke_tool(None, None)   # now over budget → note
        return first, second

    first, second = asyncio.run(run())
    assert first == "x" * 100
    payload = json.loads(second)
    assert payload["status"] == "budget_exhausted" and "error" not in payload
    assert "resets" in payload["next_step"]
    assert budget["exhausted"] is True


def test_budget_exhausted_turn_is_cut_short_with_continue_proposal():
    class FakeResult:
        final_output = "Here is what I found."

        async def stream_events(self):
            return
            yield  # noqa: unreachable — empty async generator

    budget = {"chars": 999_999, "exhausted": True}

    async def collect():
        out = []
        async for kind, data in session_agent.stream_events_for(
                FakeResult(), [], [], finalize=None, budget=budget):
            out.append((kind, data))
        return out

    events = asyncio.run(collect())
    final = next(d for k, d in events if k == "final")
    assert "cut short" in (final.get("answer") or "").lower()
    assert any(p.get("action_type") == session_agent._CONTINUE_ACTION
               for p in final.get("next_action_proposals") or [])


def test_normal_turn_without_budget_exhaustion_has_no_continue_proposal():
    class FakeResult:
        final_output = "All good."

        async def stream_events(self):
            return
            yield

    budget = {"chars": 10, "exhausted": False}

    async def collect():
        out = []
        async for kind, data in session_agent.stream_events_for(
                FakeResult(), [], [], finalize=None, budget=budget):
            out.append((kind, data))
        return out

    events = asyncio.run(collect())
    final = next(d for k, d in events if k == "final")
    assert "cut short" not in (final.get("answer") or "").lower()
    assert not any(p.get("action_type") == session_agent._CONTINUE_ACTION
                   for p in final.get("next_action_proposals") or [])
