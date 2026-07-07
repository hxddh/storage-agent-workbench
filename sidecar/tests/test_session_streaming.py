"""Streaming turn behaviors: live sanitization, cancellation, context-overflow.

The single streaming implementation (`stream_events_for`) must (a) sanitize the
LIVE delta stream — CoT-stripped, redacted, contract-block held back, tail held
back until the end; (b) stop promptly and persist a PARTIAL answer when the
user cancels; (c) treat a provider context-length overflow like a step-budget
hit (finalize, not a hard error); (d) tighten max-turns detection to the SDK's
real exception type.
"""

import asyncio
import threading

from app.agent_runtime import guardrails, session_agent


class _FakeRawEvent:
    """Mimics an SDK raw_response_event carrying a real ResponseTextDeltaEvent
    (stream_events_for isinstance-checks the delta against that type)."""

    type = "raw_response_event"

    def __init__(self, data):
        self.data = data


def _make_delta_event(text):
    from openai.types.responses import ResponseTextDeltaEvent
    data = ResponseTextDeltaEvent(
        content_index=0, delta=text, item_id="i", logprobs=[],
        output_index=0, sequence_number=0, type="response.output_text.delta",
    )
    return _FakeRawEvent(data)


def _drive(result, activity=None, cancel_event=None, clients=None):
    async def collect():
        out = []
        async for kind, data in session_agent.stream_events_for(
                result, activity if activity is not None else [], [],
                finalize=None, cancel_event=cancel_event, clients=clients):
            out.append((kind, data))
        return out
    return asyncio.run(collect())


# --- (fix 15) max-turns detection uses the real SDK type ---------------------


def test_is_max_turns_prefers_sdk_type():
    from agents.exceptions import MaxTurnsExceeded
    assert session_agent._is_max_turns(MaxTurnsExceeded("Max turns (24) exceeded"))
    # Fallback string/class-name match still works for re-raised copies.
    assert session_agent._is_max_turns(type("MaxTurnsExceeded", (Exception,), {})())
    assert not session_agent._is_max_turns(Exception("connection reset"))


# --- (fix 5) context overflow is finalized, not surfaced as an error ---------


def test_is_context_overflow_detects_provider_errors():
    assert session_agent._is_context_overflow(Exception("This model's maximum context length is 8192 tokens"))
    assert session_agent._is_context_overflow(Exception("context_length_exceeded"))
    err = Exception("bad request")
    err.code = "context_length_exceeded"
    assert session_agent._is_context_overflow(err)
    assert not session_agent._is_context_overflow(Exception("rate limit exceeded"))


def test_stream_finalizes_on_context_overflow():
    class FakeResult:
        final_output = ""

        async def stream_events(self):
            raise Exception("This model's maximum context length is 8192 tokens")
            yield  # make this an async generator

    async def finalize():
        return "Best grounded answer from evidence gathered so far."

    async def collect():
        out = []
        async for kind, data in session_agent.stream_events_for(
                FakeResult(), [], [], finalize):
            out.append((kind, data))
        return out

    events = asyncio.run(collect())
    kinds = [k for k, _ in events]
    assert "final" in kinds  # no error propagated
    final = next(d for k, d in events if k == "final")
    # The answer is present and marked as cut short by the context limit.
    assert "grounded answer" in final["answer"]
    assert "context window" in final["answer"].lower()


# --- (fix 6) live delta stream is sanitized ---------------------------------


def test_stream_deltas_are_cot_stripped_and_tail_held():
    secret = "AKIAIOSFODNN7EXAMPLE"
    # A <think> block (must never stream) then a long clean answer.
    parts = [
        "<think>hidden plan</think>",
        "The bucket is public. " * 20,
        f"Key seen: {secret}. ",
        "Done.",
    ]

    class FakeResult:
        final_output = "".join(parts)

        async def stream_events(self_inner):
            for p in parts:
                yield _make_delta_event(p)

    events = _drive(FakeResult())
    deltas = "".join(d for k, d in events if k == "delta")
    assert "hidden plan" not in deltas  # CoT never streamed
    assert secret not in deltas         # secret redacted in the live stream
    assert "The bucket is public." in deltas
    # The full clean text is recovered by the end (tail flushed).
    assert deltas.strip().endswith("Done.")


def test_stream_holds_back_contract_json_block():
    parts = [
        "Here is the answer.\n",
        '```json\n{"skills_used": [], "next_action_proposals": []}\n```',
    ]

    class FakeResult:
        final_output = "".join(parts)

        async def stream_events(self_inner):
            for p in parts:
                yield _make_delta_event(p)

    events = _drive(FakeResult())
    deltas = "".join(d for k, d in events if k == "delta")
    assert "Here is the answer." in deltas
    assert "next_action_proposals" not in deltas  # contract block never visible
    assert "```json" not in deltas


# --- (fix 3) cancellation stops promptly + persists a partial answer ---------


def test_stream_cancel_persists_partial_and_marks_stopped():
    cancel = threading.Event()
    cancelled = {"n": 0}

    class FakeResult:
        final_output = ""

        def cancel(self_inner):
            cancelled["n"] += 1

        async def stream_events(self_inner):
            yield _make_delta_event("Partial progress so far. ")
            cancel.set()  # user cancels mid-stream
            yield _make_delta_event("this should not be reached in output")

    events = _drive(FakeResult(), cancel_event=cancel)
    kinds = [k for k, _ in events]
    assert "final" in kinds
    final = next(d for k, d in events if k == "final")
    assert final.get("stopped") is True
    assert session_agent._STOPPED_MARKER in final["answer"]
    assert "Partial progress" in final["answer"]
    assert cancelled["n"] == 1  # the SDK run was actually cancelled


# --- (fix 6 helper) streaming CoT strip holds an unclosed think block --------


def test_streaming_cot_strip_holds_unclosed_think():
    # An open <think> with no close holds back everything after the tag.
    assert guardrails.strip_chain_of_thought_stream("Answer. <think>secret") == "Answer. "
    # Once closed, the paired block is removed and surrounding text kept.
    assert guardrails.strip_chain_of_thought_stream(
        "Answer. <think>secret</think> more") == "Answer.  more"


# --- (fix 6) clients are closed when the stream ends -------------------------


def test_stream_closes_per_turn_clients():
    closed = {"n": 0}

    class FakeClient:
        async def close(self_inner):
            closed["n"] += 1

    class FakeResult:
        final_output = "hello"

        async def stream_events(self_inner):
            yield _make_delta_event("hello")

    _drive(FakeResult(), clients=[FakeClient(), FakeClient()])
    assert closed["n"] == 2
