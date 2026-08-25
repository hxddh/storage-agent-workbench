"""A bound on the model call, and a token count that admits when it is partial.

Two gaps the v0.85.0 dependency sweep exposed rather than created.

**The model call was the only unbounded thing in a turn.** Every tool has had a
wall-clock ceiling since v0.56.0 (``_TOOL_TIMEOUT_S``); the model call inherited
the OpenAI client's 600 s read timeout, and the client retries twice, so a
stalled endpoint could hold a turn far longer than any tool doing the same work.
``ModelSettings.timeout`` (openai-agents 0.21.1) is the first version of the SDK
that can express this, and a trip must be RECOVERABLE — the investigation
gathered so far is still good.

**The token counts stated a total they had not established.** Usage is reported
per RESPONSE, not per endpoint: a turn's streamed answer often carries usage
while its tool-call steps do not. Summing what came back rendered a confident
"↑12.4k" that was really a floor. The SDK supplies the denominator —
``Usage.request_usage_entries`` gains a row only for a response that actually
carried usage, while ``requests`` counts every call — so the gap is computable,
and this file pins that SDK behaviour because the product now depends on it.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.agent_runtime import agent_service, session_agent


# --- the model-call bound ----------------------------------------------------


class _Recorder:
    """Captures what build_agent hands to ModelSettings, without a network."""

    def __init__(self) -> None:
        self.settings: dict[str, Any] = {}


@pytest.fixture()
def built(monkeypatch) -> _Recorder:
    rec = _Recorder()
    real = agent_service.build_agent

    def spy(*args: Any, **kwargs: Any) -> Any:
        agent = real(*args, **kwargs)
        ms = agent.model_settings
        rec.settings = {k: getattr(ms, k, None) for k in ("timeout", "temperature")}
        return agent

    monkeypatch.setattr(agent_service, "build_agent", spy)
    monkeypatch.setattr("app.agent_runtime.session_agent.build_agent", spy, raising=False)
    return rec


def test_the_model_call_is_bounded_like_every_tool_is():
    """The ceiling reaches ModelSettings, and sits above the slow-tool ceiling.

    Not an arbitrary number: it must be long enough that a legitimately slow
    streamed answer is not cut off (the SDK's deadline covers the whole attempt,
    not the gap between events) and short enough to beat the 600 s client read
    timeout it exists to replace."""
    agent = agent_service.build_agent(
        {"api_key": "k", "model": "gpt-4o-mini"}, [], "inst",
        model_timeout=session_agent._MODEL_TIMEOUT_S)
    assert agent.model_settings.timeout == session_agent._MODEL_TIMEOUT_S
    assert session_agent._TOOL_TIMEOUT_S < session_agent._MODEL_TIMEOUT_S < 600.0


def test_no_timeout_is_sent_when_none_is_configured():
    """Absent, not zero — a falsy timeout must not reach the SDK as a bound."""
    agent = agent_service.build_agent({"api_key": "k", "model": "m"}, [], "i")
    assert agent.model_settings.timeout is None


def test_a_model_timeout_is_recoverable_not_fatal():
    """It joins the 429 class: salvage the turn, don't discard the trace."""
    from agents.exceptions import ModelTimeoutError

    exc = ModelTimeoutError(30.0)
    assert session_agent._is_model_timeout(exc) is True
    # And it must not be mistaken for the states that mean something else.
    assert session_agent._is_max_turns(exc) is False
    assert session_agent._is_tool_call_sequence_error(exc) is False


def test_an_unrelated_error_is_not_read_as_a_timeout():
    assert session_agent._is_model_timeout(RuntimeError("boom")) is False
    assert session_agent._is_model_timeout(ValueError("timed out")) is False


# --- partial usage -----------------------------------------------------------


def _usage(**kw: Any) -> Any:
    from agents import Usage

    return Usage(**kw)


class _Result:
    def __init__(self, usage: Any) -> None:
        self.context_wrapper = type("C", (), {"usage": usage})()


def test_a_turn_where_every_call_reported_is_a_total_not_a_floor():
    u = _usage(requests=2, input_tokens=100, output_tokens=20, total_tokens=120)
    u.request_usage_entries = [object(), object()]
    out = session_agent._usage_snapshot(_Result(u))
    assert out["input_tokens"] == 100
    assert "reported_requests" not in out, out


def test_a_turn_where_only_some_calls_reported_is_marked_as_a_floor():
    """The defect: two of three calls silent, rendered as a confident total."""
    u = _usage(requests=3, input_tokens=100, output_tokens=20, total_tokens=120)
    u.request_usage_entries = [object()]
    out = session_agent._usage_snapshot(_Result(u))
    assert out["input_tokens"] == 100          # still the best number we have
    assert out["reported_requests"] == 1, out  # …but only 1 of 3 calls gave it


def test_a_turn_where_nothing_reported_stays_unavailable_not_a_floor():
    """The all-silent case is already handled and must not change shape: token
    counts are None, and `reported_requests` would be meaningless."""
    u = _usage(requests=2, input_tokens=0, output_tokens=0, total_tokens=0)
    out = session_agent._usage_snapshot(_Result(u))
    assert out["input_tokens"] is None and out["requests"] == 2
    assert "reported_requests" not in out, out


def test_the_sdk_still_counts_usage_the_way_this_rests_on():
    """A contract test against the Agents SDK, driven by a scripted model.

    `reported_requests` is computed from `request_usage_entries`, whose
    behaviour — one row per response that carried non-zero usage, none for a
    response that carried none — is what makes the ratio meaningful. It is
    reasonable behaviour, not documented API, so if a future SDK starts
    appending a row for an empty usage payload the product would silently go
    back to reporting a floor as a total. This fails first if that happens.

    `agents.testing` (new in openai-agents 0.21) is what makes this expressible
    without a network or an endpoint double: two runs, identical except that one
    response carries usage and the other does not.
    """
    from agents import Agent, Runner
    from agents.testing import ScriptedModel, assistant_message

    async def run_one(usage: Any | None) -> Any:
        step: dict[str, Any] = {"output": [assistant_message("done")]}
        if usage is not None:
            step["usage"] = usage
        agent = Agent(name="probe", instructions="x", model=ScriptedModel([step]))
        return (await Runner.run(agent, "go")).context_wrapper.usage

    reported = asyncio.run(run_one(
        _usage(requests=1, input_tokens=10, output_tokens=5, total_tokens=15)))
    silent = asyncio.run(run_one(None))

    assert reported.requests == 1 and len(reported.request_usage_entries) == 1
    # The call happened; the endpoint said nothing about it. That asymmetry is
    # the whole signal.
    assert silent.requests == 1 and len(silent.request_usage_entries) == 0
