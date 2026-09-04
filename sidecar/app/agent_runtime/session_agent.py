"""Agent runtime entry — the one model-driven, read-only investigator.

The runtime is split by responsibility (v1.11.0):

- ``limits``    budgets, tool groups, markers
- ``prompt``    instructions, safety rules, sanitized context/prompt builders
- ``guards``    tool wrappers: gating, timeouts, untrusted envelope, output budget
- ``steer``     mid-execution steer queue + injection
- ``usage``     token accounting + provider capability-rejection detectors
- ``finalize``  recoverable-error classifiers, tool-less finalize pass, Work Result
- ``stream``    per-segment sanitized streaming over the SDK run

This module owns what must be ONE binding process-wide: the endpoint capability
memories, the SDK agent builder, the streamed run starter, and the
``SESSION_LOOP`` test seam. ``answer`` (blocking) drives the same streaming
implementation as ``build_stream`` + ``stream_events_for`` — there is one turn
implementation. Names the rest of the app and the tests reach through this
module are re-exported below.
"""
from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable
from typing import Any

from ..security.redaction import REDACTED, redact_text
from ..skills import context as skill_context
from . import guardrails
from . import session_action_tools
from . import model_budget
from . import session_analysis_tools
from . import session_memory_tools
from . import session_tools
from .agent_service import AgentUnavailable
from .guardrails import strip_chain_of_thought, strip_chain_of_thought_stream

# FLOORS for the deterministic-summary items shown to the model; the effective
# cap is _elastic_memory_cap (scales with the window, ceiling _MEM_RECALL_CEIL).
from .limits import (_MAX_PARALLEL_TOOLS, _MAX_TURNS, _MODEL_TIMEOUT_S, seed_unlocked_groups)
from .prompt import (INSTRUCTIONS, _build_prompt)
from .usage import (_PROMPT_CACHE_RETENTION, _endpoint_key, _stash_extra_usage)
from .finalize import (_FINALIZE_FALLBACK, _answer_cap, _finalize_agent_and_prompt, _finalize_contract)
from .guards import (_build_load_tools, _build_tools, _install_tool_gating, _install_tool_output_budget, _install_tool_timeouts, _install_untrusted_envelope, _make_input_filter, _make_tool_not_found_formatter, _shorten_tool_descriptions, _strip_schema_titles)
from .steer import (_install_steer_injection)
from .stream import (_close_clients, stream_events_for)

# Re-exports: the historical single-module surface (tests + adapters reach it).
from .limits import (  # noqa: F401
    _COMPACT_AFTER_STEPS, _CONTEXT_CUT_MARKER, _CORE_TOOLS, _FIRST_DELIVERY_CHARS,
    _FIRST_DELIVERY_EXEMPT, _GROUP_OF_TOOL, _MAX_COMPLETION_TOKENS, _MAX_FACTS,
    _MAX_FINDINGS, _MAX_MESSAGES, _MAX_MESSAGES_CEIL, _MAX_OUTPUT, _MAX_REPLAY_ANSWER,
    _MAX_REPLAY_MSG, _MAX_REPLAY_MSG_CEIL, _MAX_REPLAY_TOOLS, _MAX_TOOL_OUTPUT_CHARS,
    _MAX_USER_MSG, _MAX_USER_MSG_CEIL, _MEM_RECALL_CEIL, _SLOW_TOOL_TIMEOUT_S,
    _STOPPED_MARKER, _TOOL_DESC_LIMIT, _TOOL_GROUPS, _TOOL_TIMEOUT_S,
    _UNLOCK_RECENT_CALLS, _UNTRUSTED_CLOSE, _UNTRUSTED_OPEN,
    _elastic_memory_cap, tool_group_catalog)
from .prompt import (  # noqa: F401
    FINALIZE_INSTRUCTIONS, SESSION_SAFETY_RULES, _build_agent_memory_block,
    _dedupe_replay_tools, _elastic_replay_caps, _replay_message, _replay_tools,
    active_skill_block, build_session_context, render_context_text,
    split_context_for_cache)
from .usage import (  # noqa: F401
    _is_cache_retention_rejection, _is_stream_options_rejection, _usage_snapshot)
from .finalize import (  # noqa: F401
    _ANSWER_CUT_MARKER, _finalize_directive, _is_context_overflow, _is_max_turns,
    _is_model_timeout, _is_tool_call_sequence_error, _is_transient_provider_error,
    finalize_answer_text, sanitize_answer_text)
from .guards import (  # noqa: F401
    _compact_consumed_outputs, _first_delivery_digest, _shorten_tool_description)
from .steer import SteerQueue  # noqa: F401
from .stream import _StreamSanitizer  # noqa: F401

# Endpoints that rejected `stream_options` (the parameter that makes streamed
# token usage observable). Keyed by base_url+model. Provider compatibility
# outranks a metrics field: once an endpoint refuses, this process stops asking
# and the session honestly reports usage as unavailable rather than failing turns.
_NO_USAGE_ENDPOINTS: set[str] = set()

# Endpoints that mishandled PARALLEL tool calls (v0.54.0). Same shape and same
# reasoning as _NO_USAGE_ENDPOINTS: try the capability, and when a specific
# provider proves it cannot honour it, remember that for the process and stop
# asking. Sequential tool calls are strictly slower and more expensive — every
# probe becomes its own round-trip carrying the whole accumulated conversation —
# so paying that everywhere to accommodate the providers that break is the wrong
# default; paying it only where it is actually needed is the right one.
_NO_PARALLEL_ENDPOINTS: set[str] = set()

# Endpoints that rejected `prompt_cache_retention` (v0.55.0). Same shape as the
# two capability memories above: ask once, remember a refusal for the process,
# never let a cost optimization cost a turn.
_NO_CACHE_RETENTION_ENDPOINTS: set[str] = set()
def forget_endpoint_capabilities(base_url: str | None, model: str | None) -> None:
    """Drop remembered capability refusals for one endpoint (v1.13).

    Called when `POST /model-providers/{id}/test` succeeds: a proxy upgrade
    that fixed usage/parallel/cache support must not wait for a Sidecar
    restart to be retried. Best-effort; never raises."""
    try:
        key = f"{base_url or 'openai'}|{model or ''}"
        _NO_USAGE_ENDPOINTS.discard(key)
        _NO_PARALLEL_ENDPOINTS.discard(key)
        _NO_CACHE_RETENTION_ENDPOINTS.discard(key)
    except Exception:  # noqa: BLE001 — bookkeeping must never fail a request
        pass


# What we ask for when the endpoint accepts it. "24h" is OpenAI's extended
# retention; the default (5-10 minutes) expires between a user's questions,
# which is exactly the gap that matters here — the fixed prefix is identical
# across the turns of one investigation, not just across the steps of one turn.
def _make_agent(creds: dict[str, Any], tools: list[Any], instructions: str,
                client_registry: list[Any] | None = None) -> Any:
    """Build the session Agent via the shared per-run builder (no SDK globals)."""
    from .agent_service import AGENT_TEMPERATURE, build_agent
    # Completion budget scales with the model's context window (floor =
    # _MAX_COMPLETION_TOKENS), so a large-window model isn't capped to the value
    # a small one needs. Never below the floor, never above provider max-output.
    return build_agent(creds, tools, instructions, name="Storage Agent",
                       max_tokens=model_budget.completion_token_budget(
                           creds.get("model"), creds.get("context_window"),
                           creds.get("max_output_tokens")),
                       parallel_tool_calls=_endpoint_key(creds) not in _NO_PARALLEL_ENDPOINTS,
                       client_registry=client_registry,
                       include_usage=_endpoint_key(creds) not in _NO_USAGE_ENDPOINTS,
                       prompt_cache_retention=(
                           None if _endpoint_key(creds) in _NO_CACHE_RETENTION_ENDPOINTS
                           else _PROMPT_CACHE_RETENTION),
                       # An operator may override per provider; None keeps the
                       # investigator default (AGENT_TEMPERATURE).
                       temperature=creds.get("temperature", AGENT_TEMPERATURE),
                       model_timeout=_MODEL_TIMEOUT_S,
                       reasoning_effort=creds.get("reasoning_effort"))


# --- graceful step-budget finalize -----------------------------------------
# When the agent exhausts its turn budget (max_turns) the OpenAI Agents SDK
# raises MaxTurnsExceeded. That must NOT surface as a hard error: instead we make
# ONE tool-less model call that synthesizes a best-effort answer from the work
# already done. Tools are disabled, so the model can only emit text — the call is
# guaranteed to terminate with a grounded answer. The turn budget is preserved
# (N tool-loop turns + 1 tool-less finalize); nothing new can be probed here.
# The SAME pass handles a provider context-length overflow: the finalize call is
# a fresh, small request (prompt + trace), so it fits where the overloaded
# tool-loop conversation no longer did.

def _start_streamed_run(spec: dict[str, Any], clients: list[Any] | None = None):
    """Start the SDK streaming run for a prepared spec.

    Returns (result_streaming, finalize, clients). ``clients`` collects every
    AsyncOpenAI client created for this turn so the driver can close them when
    the turn ends. Raises AgentUnavailable if the SDK is missing.
    """
    try:
        import openai  # noqa: F401
        from agents import RunConfig, Runner, function_tool
        from agents.run_config import ToolExecutionConfig
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    creds = spec["creds"]
    activity: list[dict[str, Any]] = spec["activity"]
    # ``clients`` is CALLER-OWNED: _make_agent registers each per-turn client in
    # it BEFORE run_streamed, so if anything here raises the caller's finally can
    # still close it (otherwise a client created just before a run_streamed error
    # would leak its HTTP pool, since stream_events_for's close never runs).
    if clients is None:
        clients = []
    unlocked = seed_unlocked_groups(spec.get("conn"), spec.get("session_id"),
                                    bool(spec.get("attachments")))
    tools = _build_tools(spec.get("conn"), function_tool, activity,
                         spec.get("session_id"), spec.get("turn_id"),
                         spec.get("cancel_event"), model=creds.get("model"),
                         explicit_window=creds.get("context_window"),
                         unlocked=unlocked)
    # Progressive tool disclosure (v0.55.0). The gate is installed BEFORE the
    # wrappers so `load_tools` is itself wrapped like any other tool; `unlocked`
    # is seeded from what this session has actually needed before (and from the
    # plain fact that a file is attached), so a continuing investigation does not
    # re-pay the unlock round-trip every turn.
    tools.append(_build_load_tools(function_tool, unlocked, activity))
    _shorten_tool_descriptions(tools)
    _install_tool_gating(tools, unlocked)
    _strip_schema_titles(tools)
    _install_tool_timeouts(tools)
    spec["unlocked_groups"] = unlocked
    # Envelope first (inner), budget second (outer): the budget's runtime status
    # notes bypass the envelope, real payloads are wrapped, and the budget
    # counts the enveloped length it actually hands the model.
    _install_untrusted_envelope(tools)
    budget = _install_tool_output_budget(tools, model=creds.get("model"),
                                         explicit_window=creds.get("context_window"),
                                         explicit_token_budget=creds.get("turn_token_budget"),
                                         cancel_event=spec.get("cancel_event"))
    spec["budget"] = budget  # readable by the blocking driver, which owns `spec`
    # Steer delivery is the OUTERMOST wrapper: a steer note must ride on every
    # tool return (real payloads and budget statuses alike) and stay outside the
    # untrusted-data envelope — it is the user's own direction.
    _install_steer_injection(tools, spec.get("steer_queue"), activity)
    # _make_agent asks for PARALLEL tool calls unless this endpoint has already
    # proven it mishandles them (v0.54.0). Independent probes then batch into one
    # step instead of one round-trip each, and every avoided round-trip avoids
    # re-sending the entire accumulated conversation — measured at ~36% of a
    # realistic 8-tool turn. Chat-completions gateways that emit malformed
    # follow-ups are detected by _is_tool_call_sequence_error and remembered in
    # _NO_PARALLEL_ENDPOINTS. It uses a per-run client so concurrent sessions
    # don't race on SDK globals.
    agent = _make_agent(creds, tools, INSTRUCTIONS, clients)
    # Compact already-consumed tool results before each model call (v0.57.0).
    # Measured: 81% of the turn's tool-output cost is re-sending output the agent
    # read several steps ago. RunConfig.call_model_input_filter is the SDK's own
    # hook for this — the input list is handed to us and taken back modified.
    compaction: dict[str, int] = {}
    spec["compaction"] = compaction
    # A call to a still-locked tool must be a CORRECTION, not the end of the turn
    # (v0.58.0). The SDK defaults `tool_not_found_behavior` to "raise_error", and
    # since v0.55.0 gated 29 of 43 tools behind `is_enabled`, a locked tool is
    # genuinely "not found" to the runtime. The model is TOLD those tools exist —
    # `tool_group_catalog()` lists every group in the instructions — so naming one
    # before unlocking it is a predictable move, and it raised ModelBehaviorError,
    # which is not in this turn's `recoverable` set. One wrong tool name therefore
    # discarded an entire investigation's evidence with a raw error.
    #
    # Returning the error to the model instead costs one step and turns a fatal
    # mistake into a self-correcting one; the formatter below makes it actionable
    # rather than merely non-fatal.
    unlock_hint = _make_tool_not_found_formatter(unlocked)
    # openai-agents 0.22: RunConfig.group_id is the Chat Completions
    # prompt_cache_key grouping. Official OpenAI then routes later turns of the
    # SAME task to the same cache machines (prefix caching only helps if the
    # request lands where the prefix lives). Third-party endpoints skip the
    # extra arg (`_supports_default_prompt_cache_key` is official-OpenAI only).
    # We do NOT use OpenAIResponsesCompactionSession / context_management —
    # those are Responses-API only, and this product stays on Chat Completions
    # so DeepSeek / Ollama / vLLM keep working.
    run_config = RunConfig(call_model_input_filter=_make_input_filter(compaction),
                           tool_not_found_behavior="return_error_to_model",
                           tool_error_formatter=unlock_hint,
                           tool_execution=ToolExecutionConfig(
                               max_function_tool_concurrency=_MAX_PARALLEL_TOOLS),
                           group_id=spec.get("session_id") or None)
    result = Runner.run_streamed(agent, spec["prompt"], max_turns=_MAX_TURNS,
                                 run_config=run_config)
    # Tag the run with the endpoint it targets, so a stream_options rejection
    # raised mid-stream can be attributed to THIS endpoint without threading
    # creds through the (creds-free) event pump.
    try:
        result._sa_endpoint_key = _endpoint_key(creds)
    except Exception:  # noqa: BLE001
        pass

    async def _finalize() -> str:
        """One tool-less call to synthesize a grounded answer when the step
        budget (or the context window) is hit mid-stream. Never raises —
        returns a safe fallback on any error."""
        try:
            fa, fp = _finalize_agent_and_prompt(creds, spec["prompt"], activity, clients)
            fr = await Runner.run(fa, fp, max_turns=2,
                                  run_config=RunConfig(group_id=spec.get("session_id") or None))
            _stash_extra_usage(result, fr)
            return getattr(fr, "final_output", "") or _FINALIZE_FALLBACK
        except Exception:  # noqa: BLE001
            return _FINALIZE_FALLBACK

    return result, _finalize, clients


def _streamed_session_loop(spec: dict[str, Any]) -> dict[str, Any]:
    """Default SESSION_LOOP: drive the SAME streaming implementation to
    completion on a private event loop and return the final contract dict.

    This is the blocking endpoint's turn — there is no second, parallel
    tool-loop implementation. Tests monkeypatch SESSION_LOOP with fakes that
    return plain text; ``answer`` handles both shapes.
    """
    try:
        async def _drive() -> dict[str, Any]:
            # Runner.run_streamed schedules the agent loop via asyncio.create_task,
            # so it MUST be started from WITHIN the running loop — not before it.
            # Calling _start_streamed_run() outside run_until_complete raises
            # "no running event loop" (the blocking-fallback crash a client hit
            # when it fell back to POST /messages after switching sessions).
            clients: list[Any] = []
            try:
                result, finalize, _ = _start_streamed_run(spec, clients)
            except BaseException:
                # _start_streamed_run raised after creating a client → close it
                # here, since stream_events_for (the normal closer) never runs.
                await _close_clients(clients)
                raise
            final: dict[str, Any] = {}
            async for kind, data in stream_events_for(
                    result, spec["activity"], spec.get("skill_names") or [], finalize,
                    cancel_event=spec.get("cancel_event"), clients=clients,
                    budget=spec.get("budget"),
                    answer_cap=_answer_cap(spec.get("creds"))):
                if kind == "final":
                    final = data
            return final

        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_drive())
        finally:
            # Drain before close (same discipline as the streaming worker): a
            # hard provider error exits _drive with run_streamed's background
            # task still pending — closing the loop then leaves it destroyed
            # un-finalized and SDK asyncgens never aclose'd.
            try:
                pending = asyncio.all_tasks(loop)
                for t in pending:
                    t.cancel()
                if pending:
                    loop.run_until_complete(
                        asyncio.gather(*pending, return_exceptions=True))
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:  # noqa: BLE001
                pass
            loop.close()
    except AgentUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable(f"Session assistant failed: {redact_text(str(exc))}") from exc


# Monkeypatch in tests to inject a fake loop (no SDK / no API key).
SESSION_LOOP: Callable[[dict[str, Any]], Any] = _streamed_session_loop


def answer(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    creds: dict[str, Any],
    conn: Any = None,
    turn_id: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    cancel_event: Any = None,
) -> dict[str, Any]:
    """Skill-grounded, sanitized session answer contract. Raises AgentUnavailable.

    Returns {answer, skills_used, evidence_used, evidence_gaps,
    next_action_proposals} — all sanitized + CoT-stripped; proposals coerced +
    forbidden-token-filtered. Drives the same streaming implementation as the
    SSE endpoint (via SESSION_LOOP) to completion.
    """
    prompt, skill_names, context = _build_prompt(session, summary, recent_messages, user_message,
                                                 conn, attachments, model=creds.get("model"),
                                                 explicit_window=creds.get("context_window"))

    activity: list[dict[str, Any]] = []
    spec = {"context": context, "prompt": prompt, "instructions": INSTRUCTIONS,
            "creds": creds, "conn": conn, "activity": activity,
            "session_id": session.get("id"), "turn_id": turn_id,
            "skill_names": skill_names, "cancel_event": cancel_event,
            # v0.55.0: an attached file is a FACT, not a guess at intent —
            # it seeds the uploaded_files tool group open (seed_unlocked_groups).
            "attachments": attachments}
    raw = SESSION_LOOP(spec)
    if isinstance(raw, dict):  # the real (streamed) loop returns the contract
        return raw
    return _finalize_contract(raw, skill_names, activity, cap=_answer_cap(creds))


# --- Streaming path (SDK-only; used by the SSE endpoint) --------------------

def build_stream(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    creds: dict[str, Any],
    conn: Any,
    turn_id: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    cancel_event: Any = None,
    clients: list[Any] | None = None,
    steer_queue: Any = None,
):
    """Set up a streaming run.

    Returns (result_streaming, activity, skill_names, finalize, clients, budget).
    ``clients`` may be passed in so the CALLER owns closing them even if this
    setup raises after a client was created (see _start_streamed_run). ``budget``
    is the per-turn tool-output budget state; pass it to ``stream_events_for`` so
    a budget-exhausted turn is marked cut-short with a "continue" proposal.
    Raises AgentUnavailable if the SDK/key is unavailable — caller should then
    fall back to the blocking endpoint.
    """
    if clients is None:
        clients = []
    prompt, skill_names, _context = _build_prompt(session, summary, recent_messages, user_message,
                                                  conn, attachments, model=creds.get("model"),
                                                  explicit_window=creds.get("context_window"))
    activity: list[dict[str, Any]] = []
    spec = {"prompt": prompt, "creds": creds, "conn": conn, "activity": activity,
            "session_id": session.get("id"), "turn_id": turn_id,
            "cancel_event": cancel_event, "steer_queue": steer_queue,
            # v0.55.0: seeds the uploaded_files tool group (seed_unlocked_groups).
            "attachments": attachments}
    result, finalize, _ = _start_streamed_run(spec, clients)
    return result, activity, skill_names, finalize, clients, spec.get("budget")




__all__ = ["SESSION_LOOP", "SteerQueue", "build_session_context", "render_context_text",
           "answer", "build_stream", "stream_events_for", "SESSION_SAFETY_RULES",
           "INSTRUCTIONS", "FINALIZE_INSTRUCTIONS"]
