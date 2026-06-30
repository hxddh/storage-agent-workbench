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
