"""Session assistant — interpretation only (Phase 16).

When a user asks a question in a session, the deterministic session summary is
built first; the model then sees ONLY a bounded, sanitized context (session
goal + summary facts/findings/open-questions/next-actions + recent messages) and
answers. It has NO tools: it cannot run anything, download evidence, change
config, run SQL, call S3, or use a shell. It can explain progress, attribute a
problem, weigh evidence strength, recommend which next action to take, and draft
a report — but it only ever proposes; the user acts.

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
from .agent_service import AgentUnavailable
from .guardrails import strip_chain_of_thought

_MAX_FACTS = 30
_MAX_FINDINGS = 30
_MAX_MESSAGES = 12
_MAX_OUTPUT = 4000

SESSION_SAFETY_RULES = [
    "You receive ONLY a sanitized session summary and recent messages — no raw "
    "logs, no raw inventory rows, no credentials, no SQL, no tools.",
    "You cannot execute anything. You may explain, attribute, weigh evidence, and "
    "recommend which existing next-action proposal to take — the user acts on it.",
    "Distinguish facts (from runs) from inferences and suggestions; flag low-"
    "confidence claims.",
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
    "You are the assistant for a storage-diagnostics work session. You are given "
    "a JSON context: the session goal, a deterministic summary (known facts, "
    "findings, open questions, suggested next actions, limitations), and the "
    "recent message thread. You may also be given StorageOps skills as "
    "PROFESSIONAL DIAGNOSTIC METHODS.\n"
    "Use the StorageOps skills as professional methods. Use session evidence as "
    "factual grounding. Do not invent evidence. Do not claim any tool/script/CLI "
    "was run. Do not request helper-script execution. If evidence is "
    "insufficient, ask for the missing evidence or propose an existing safe next "
    "action. If no provided skill is applicable, say so in your answer. Make "
    "clear which statements are well-evidenced facts vs. inferences. Follow all "
    "safety_rules.\n\n"
    f"Available next-action types (proposals only): {_PROPOSAL_ACTION_TYPES}."
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
    """Default one-shot loop via the OpenAI Agents SDK (lazy import, no tools)."""
    try:
        import openai  # noqa: F401
        from agents import Agent, Runner, set_default_openai_key
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    creds = spec["creds"]
    try:
        if creds.get("base_url"):
            from agents import set_default_openai_client
            client = openai.AsyncOpenAI(api_key=creds["api_key"], base_url=creds["base_url"])
            set_default_openai_client(client)
        else:
            set_default_openai_key(creds["api_key"])
        agent = Agent(name="Session Assistant", instructions=spec["instructions"],
                      tools=[], model=creds.get("model"))
        result = Runner.run_sync(agent, spec["prompt"])
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


def answer(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    creds: dict[str, Any],
) -> dict[str, Any]:
    """Skill-grounded, sanitized session answer contract. Raises AgentUnavailable.

    Returns {answer, skills_used, evidence_used, evidence_gaps,
    next_action_proposals} — all sanitized + CoT-stripped; proposals coerced
    through the Phase 17 allowlist. StorageOps skills are injected as guidance
    only (tools/scripts disabled).
    """
    context = build_session_context(session, summary, recent_messages)
    skill_ctx = skill_context.build_skill_context(
        _skill_query_text(session, summary, user_message))
    skill_names = [s["name"] for s in skill_ctx["skills"]]

    prompt_parts = [render_context_text(context)]
    if skill_ctx["text"]:
        prompt_parts.append(skill_ctx["text"])
    prompt_parts.append(f"User question:\n{redact_text(user_message)[:2000]}")
    prompt_parts.append(skill_contract.CONTRACT_INSTRUCTION)
    prompt = "\n\n".join(prompt_parts)

    spec = {"context": context, "prompt": prompt, "instructions": INSTRUCTIONS, "creds": creds}
    raw = SESSION_LOOP(spec)
    contract = skill_contract.parse_agent_contract(raw, allowed_skill_names=skill_names)
    contract["answer"] = contract["answer"][:_MAX_OUTPUT]
    # Record which skills were offered (selection), distinct from skills_used.
    contract["skills_offered"] = skill_names
    return contract


__all__ = ["SESSION_LOOP", "build_session_context", "render_context_text", "answer",
           "SESSION_SAFETY_RULES", "INSTRUCTIONS"]
