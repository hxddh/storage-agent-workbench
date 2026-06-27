"""Session assistant — a live, read-only investigator.

When a user asks a question, the deterministic session summary is built first
for grounding; the agent then investigates LIVE using read-only tools
(list_providers, list_buckets, head_bucket, bounded list_objects, and the
review_bucket_* config tools — see ``session_tools``) and answers from their
results. It chooses the provider/bucket itself.

Every tool is read-only, bounded, audited, and secret-safe — there are no
mutating or destructive operations, and credentials never reach the model.
Anything that moves data or runs an analysis/large scan (evidence import,
inventory/access-log analysis, a session report) is NOT done inline; it is
proposed as a next step the user confirms.

The real LLM call is behind the ``SESSION_LOOP`` seam so tests inject a fake
(no SDK / no API key). Output is redacted + chain-of-thought-stripped + bounded.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from ..security.redaction import redact_text
from ..skills import context as skill_context
from ..skills import contract as skill_contract
from . import guardrails
from . import session_tools
from .agent_service import AgentUnavailable
from .guardrails import strip_chain_of_thought

_MAX_FACTS = 30
_MAX_FINDINGS = 30
_MAX_MESSAGES = 12
_MAX_OUTPUT = 12000  # room to actually enumerate (e.g. list all bucket names)

SESSION_SAFETY_RULES = [
    "Tool results are visible to YOU, not to the user — the user only sees a "
    "one-line trace like 'list_buckets → 96 buckets'. So include any data the "
    "user asked for directly in your answer: when asked to list/enumerate, "
    "actually write the items out (a list or table). Never say 'listed above', "
    "'see the table', or claim you displayed something you didn't write.",
    "Investigate live with your read-only tools (list_providers, list_buckets, "
    "head_bucket, list_objects, review_bucket_*). Ground every claim in a tool "
    "result or the session summary — never invent buckets, configs, or numbers.",
    "All tools are read-only and bounded; there are no destructive or mutating "
    "operations. For anything that downloads data or runs an analysis/large scan "
    "(evidence import, inventory/access-log analysis, a report), propose it as a "
    "next step for the user to confirm — do not imply you did it.",
    "Distinguish facts (from tools/runs) from inferences and suggestions; flag "
    "low-confidence claims.",
    "Never output credentials, access/secret/session keys, model API keys, "
    "Authorization headers, cookies, signatures, or presigned-URL parameters.",
    "Do not include hidden chain-of-thought; answer concisely.",
]

_PROPOSAL_ACTION_TYPES = (
    "run_account_discovery, run_bucket_config_review, run_diagnostic, "
    "plan_inventory_import, plan_access_log_import, run_inventory_analysis, "
    "run_access_log_analysis, generate_session_report, ask_user_for_context"
)

INSTRUCTIONS = (
    "You are Storage Agent, an expert object-storage diagnostician. Investigate "
    "the user's question LIVE using your read-only tools, then answer from what "
    "you find.\n"
    "The configured cloud providers are already listed for you in the context "
    "(configured_providers) — use those provider_id values directly; you do NOT "
    "need to call list_providers. Then call the tools you need — list_buckets to "
    "enumerate buckets, head_bucket / list_objects to probe, and review_bucket_* "
    "/ get_bucket_config_summary to assess configuration — and base your answer "
    "on their results.\n"
    "Tool outputs are NOT shown to the user (they only see a short trace), so "
    "when they ask you to list or show something, write the actual items in your "
    "answer — never say 'see above'.\n"
    "You are also given a JSON context (session goal, a deterministic summary, "
    "recent messages) and StorageOps skills as PROFESSIONAL DIAGNOSTIC METHODS — "
    "use them as method and grounding. Never invent buckets, configs, numbers, or "
    "results you didn't obtain from a tool or the summary. Be concise and "
    "concrete; make clear which statements are tool-verified facts vs. "
    "inferences.\n"
    "All tools are read-only. For anything that downloads data or runs an "
    "analysis/large scan, propose it as a next step (do not imply you ran it). "
    "Follow all safety_rules.\n\n"
    f"Next-action types you may propose (for confirmed runs only): {_PROPOSAL_ACTION_TYPES}."
)


def build_session_context(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
) -> dict[str, Any]:
    """Bounded, redacted context — the ONLY thing the model sees."""
    findings = []
    for f in (summary.get("findings") or [])[:_MAX_FINDINGS]:
        findings.append({
            "severity": str(f.get("severity", "info"))[:32],
            "confidence": str(f.get("confidence", "medium"))[:16],
            "title": redact_text(str(f.get("title", "")))[:200],
            "interpretation": redact_text(str(f.get("interpretation", "")))[:300],
            "source_run_id": str(f.get("source_run_id") or "")[:64],
        })
    context = {
        "session": {
            "title": redact_text(str(session.get("title", ""))),
            "goal": redact_text(str(session.get("goal") or "")),
            "status": session.get("status", "active"),
        },
        "summary": {
            "known_facts": [
                {"text": redact_text(str(f.get("text", "")))[:300],
                 "confidence": f.get("confidence", "medium"),
                 "source_run_id": str(f.get("source_run_id") or "")[:64]}
                for f in (summary.get("known_facts") or [])[:_MAX_FACTS]
            ],
            "findings": findings,
            "open_questions": [redact_text(str(q))[:300] for q in (summary.get("open_questions") or [])[:_MAX_FACTS]],
            "next_actions": [
                {"title": redact_text(str(a.get("title", "")))[:160],
                 "action_type": str(a.get("action_type", ""))[:64],
                 "confidence": a.get("confidence", "medium")}
                for a in (summary.get("next_actions") or [])[:_MAX_FACTS]
            ],
            "limitations": [redact_text(str(x))[:300] for x in (summary.get("limitations") or [])[:_MAX_FACTS]],
        },
        "recent_messages": [
            {"role": m.get("role"), "content": redact_text(str(m.get("content", "")))[:1000]}
            for m in recent_messages[-_MAX_MESSAGES:]
        ],
        "safety_rules": SESSION_SAFETY_RULES,
    }
    guardrails.assert_no_secrets_in_context(context)
    return context


def render_context_text(context: dict[str, Any]) -> str:
    return json.dumps(context, indent=2, default=str)


def _sdk_session_loop(spec: dict[str, Any]) -> Any:
    """Default loop via the OpenAI Agents SDK (lazy import) with read-only tools."""
    try:
        import openai  # noqa: F401
        from agents import Agent, Runner, function_tool, set_default_openai_key, set_tracing_disabled
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    creds = spec["creds"]
    conn = spec.get("conn")
    try:
        # Never upload traces/prompts to OpenAI's backend (privacy; also avoids a
        # spurious OpenAI auth call that fails when using a third-party provider).
        set_tracing_disabled(True)
        if creds.get("base_url"):
            # Third-party OpenAI-compatible provider (e.g. DeepSeek): point the
            # client at its base_url and use Chat Completions — these providers
            # don't implement the OpenAI Responses API the SDK defaults to.
            from agents import set_default_openai_client, set_default_openai_api
            client = openai.AsyncOpenAI(api_key=creds["api_key"], base_url=creds["base_url"])
            set_default_openai_client(client)
            set_default_openai_api("chat_completions")
        else:
            set_default_openai_key(creds["api_key"])
        tools = session_tools.build(conn, function_tool, spec.get("activity")) if conn is not None else []
        agent = Agent(name="Storage Agent", instructions=spec["instructions"],
                      tools=tools, model=creds.get("model"))
        result = Runner.run_sync(agent, spec["prompt"], max_turns=8)
        return getattr(result, "final_output", "")
    except AgentUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable(f"Session assistant failed: {redact_text(str(exc))}") from exc


# Monkeypatch in tests to inject a fake loop (no SDK / no API key).
SESSION_LOOP: Callable[[dict[str, Any]], Any] = _sdk_session_loop


def _skill_query_text(session: dict[str, Any], summary: dict[str, Any], user_message: str) -> str:
    facts = " ".join(str(f.get("text", "")) for f in (summary.get("known_facts") or [])[:10])
    return " ".join([str(session.get("goal") or ""), facts, user_message or ""])


def _build_prompt(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    conn: Any,
) -> tuple[str, list[str], dict[str, Any]]:
    """Build the sanitized prompt + selected skill names + context (shared)."""
    context = build_session_context(session, summary, recent_messages)
    skill_ctx = skill_context.build_skill_context(
        _skill_query_text(session, summary, user_message))
    skill_names = [s["name"] for s in skill_ctx["skills"]]

    prompt_parts = [render_context_text(context)]
    # Pre-list configured providers so the agent skips a list_providers round
    # trip (latency) and already knows the provider_id values. No secrets.
    providers: list[dict[str, Any]] = []
    if conn is not None:
        try:
            from ..repositories import cloud_providers as cloud_repo
            providers = [{"provider_id": p.id, "name": p.name, "type": p.provider_type,
                          "region": p.region, "endpoint": p.endpoint_url}
                         for p in cloud_repo.list_all(conn)]
        except Exception:  # noqa: BLE001
            providers = []
    prompt_parts.append("configured_providers:\n" + json.dumps(providers, ensure_ascii=False))
    if skill_ctx["text"]:
        prompt_parts.append(skill_ctx["text"])
    prompt_parts.append(f"User question:\n{redact_text(user_message)[:2000]}")
    prompt_parts.append(skill_contract.CONTRACT_INSTRUCTION)
    return "\n\n".join(prompt_parts), skill_names, context


def _finalize_contract(raw: Any, skill_names: list[str], activity: list[dict[str, Any]]) -> dict[str, Any]:
    contract = skill_contract.parse_agent_contract(raw, allowed_skill_names=skill_names)
    contract["answer"] = contract["answer"][:_MAX_OUTPUT]
    contract["skills_offered"] = skill_names
    contract["tool_activity"] = activity
    return contract


def answer(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    creds: dict[str, Any],
    conn: Any = None,
) -> dict[str, Any]:
    """Skill-grounded, sanitized session answer contract. Raises AgentUnavailable.

    Returns {answer, skills_used, evidence_used, evidence_gaps,
    next_action_proposals} — all sanitized + CoT-stripped; proposals coerced
    through the Phase 17 allowlist. StorageOps skills are injected as guidance
    only (tools/scripts disabled).
    """
    prompt, skill_names, context = _build_prompt(session, summary, recent_messages, user_message, conn)

    activity: list[dict[str, Any]] = []
    spec = {"context": context, "prompt": prompt, "instructions": INSTRUCTIONS,
            "creds": creds, "conn": conn, "activity": activity}
    raw = SESSION_LOOP(spec)
    return _finalize_contract(raw, skill_names, activity)


# --- Streaming path (SDK-only; used by the SSE endpoint) --------------------

def build_stream(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    creds: dict[str, Any],
    conn: Any,
):
    """Set up a streaming run. Returns (result_streaming, activity, skill_names).

    Raises AgentUnavailable if the SDK/key is unavailable — caller should then
    fall back to the blocking endpoint.
    """
    try:
        import openai  # noqa: F401
        from agents import (Agent, ModelSettings, Runner, function_tool,
                            set_default_openai_key, set_tracing_disabled)
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    prompt, skill_names, _context = _build_prompt(session, summary, recent_messages, user_message, conn)
    set_tracing_disabled(True)
    if creds.get("base_url"):
        from agents import set_default_openai_client, set_default_openai_api
        client = openai.AsyncOpenAI(api_key=creds["api_key"], base_url=creds["base_url"])
        set_default_openai_client(client)
        set_default_openai_api("chat_completions")
    else:
        set_default_openai_key(creds["api_key"])
    activity: list[dict[str, Any]] = []
    tools = session_tools.build(conn, function_tool, activity)
    # Disable parallel tool calls: with chat-completions providers (e.g. DeepSeek)
    # streaming + parallel tool_calls can produce malformed follow-up messages.
    agent = Agent(name="Storage Agent", instructions=INSTRUCTIONS, tools=tools,
                  model=creds.get("model"), model_settings=ModelSettings(parallel_tool_calls=False))
    result = Runner.run_streamed(agent, prompt, max_turns=8)
    return result, activity, skill_names


async def stream_events_for(result: Any, activity: list[dict[str, Any]], skill_names: list[str]):
    """Yield ('delta', text) and ('tool', record) during the run, then
    ('final', contract) when complete."""
    from openai.types.responses import ResponseTextDeltaEvent
    emitted = 0
    async for event in result.stream_events():
        if getattr(event, "type", "") == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
            if event.data.delta:
                yield ("delta", event.data.delta)
        while len(activity) > emitted:
            yield ("tool", activity[emitted])
            emitted += 1
    while len(activity) > emitted:
        yield ("tool", activity[emitted])
        emitted += 1
    yield ("final", _finalize_contract(getattr(result, "final_output", "") or "", skill_names, activity))


__all__ = ["SESSION_LOOP", "build_session_context", "render_context_text", "answer",
           "build_stream", "stream_events_for", "SESSION_SAFETY_RULES", "INSTRUCTIONS"]
