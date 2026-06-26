"""Interpretation-only Agent for error triage (Phase 18).

The model sees ONLY the sanitized triage context built here — parsed signals,
candidate-cause titles/why, and safe next checks — NEVER the raw stack trace or
log, never credentials, never tools. It explains and prioritizes; it cannot run
anything. Output is redacted + chain-of-thought-stripped. Behind the
``TRIAGE_LOOP`` seam so tests inject a fake (no SDK / no API key).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from ..agent_runtime import guardrails
from ..agent_runtime.agent_service import AgentUnavailable
from ..agent_runtime.guardrails import strip_chain_of_thought
from ..security.redaction import redact_text
from ..skills import contract as skill_contract

_MAX_CAUSES = 8
_MAX_OUTPUT = 3000

SAFETY_RULES = [
    "You receive ONLY parsed signals + candidate causes — never the raw stack trace/log.",
    "You have NO tools: you cannot run diagnostics, download evidence, call S3, or change config.",
    "Explain and prioritize the candidate causes; recommend which safe next check to do first.",
    "Never output credentials, keys, tokens, Authorization headers, cookies, or signatures.",
    "Do not include hidden chain-of-thought; be concise.",
]

INSTRUCTIONS = (
    "You are a senior object-storage / S3 support engineer triaging an error. You "
    "are given a JSON context: parsed error signals, deterministic candidate "
    "causes (with confidence), safe next checks, and optional session context. "
    "You may also be given StorageOps skills as PROFESSIONAL DIAGNOSTIC METHODS — "
    "use them as methods, do not claim any tool/script/CLI was run, and do not "
    "request helper-script execution. Explain the most likely cause(s) in plain "
    "language, say which candidate is strongest and why, and recommend which SAFE "
    "next check to run first. Reference only the provided candidate causes / next "
    "checks / skills and the existing next-action proposals — never invent a step "
    "that downloads data, changes configuration, or runs anything itself. If "
    "evidence is missing, state the gap. Follow all safety_rules."
)


def build_triage_context(
    parsed: dict[str, Any],
    candidate_causes: list[dict[str, Any]],
    session_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Sanitized, bounded context — the ONLY thing the model sees (no raw blob)."""
    safe_parsed = {
        k: parsed.get(k) for k in (
            "input_kind", "error_code", "http_status", "region", "endpoint", "bucket",
            "method", "operation", "language", "flags", "recognized")
    }
    # redact any string-ish parsed values defensively
    for k, v in list(safe_parsed.items()):
        if isinstance(v, str):
            safe_parsed[k] = redact_text(v)[:200]

    causes = [{
        "title": redact_text(str(c.get("title", "")))[:200],
        "confidence": c.get("confidence", "medium"),
        "category": c.get("category"),
        "why": redact_text(str(c.get("interpretation", "")))[:400],
        "next_checks": [redact_text(str(x))[:160] for x in (c.get("next_checks") or [])[:10]],
    } for c in candidate_causes[:_MAX_CAUSES]]

    context = {
        "parsed": safe_parsed,
        "candidate_causes": causes,
        "session_context": session_context or {},
        "safety_rules": SAFETY_RULES,
    }
    guardrails.assert_no_secrets_in_context(context)
    return context


def render_context_text(context: dict[str, Any]) -> str:
    return json.dumps(context, indent=2, default=str)


def _sdk_triage_loop(spec: dict[str, Any]) -> Any:
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
        agent = Agent(name="Error Triage Assistant", instructions=spec["instructions"],
                      tools=[], model=creds.get("model"))
        result = Runner.run_sync(agent, spec["prompt"])
        return getattr(result, "final_output", "")
    except AgentUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable(f"Error-triage assistant failed: {redact_text(str(exc))}") from exc


# Monkeypatch in tests to inject a fake loop (no SDK / no API key).
TRIAGE_LOOP: Callable[[dict[str, Any]], Any] = _sdk_triage_loop


def interpret(
    parsed: dict[str, Any],
    candidate_causes: list[dict[str, Any]],
    session_context: dict[str, Any] | None,
    creds: dict[str, Any],
    skill_context_text: str = "",
    skill_names: list[str] | None = None,
) -> dict[str, Any]:
    """Skill-grounded triage contract. Raises AgentUnavailable.

    Returns {answer, skills_used, evidence_used, evidence_gaps,
    next_action_proposals} — all sanitized + CoT-stripped. The raw blob is never
    sent; StorageOps skills are injected as guidance only.
    """
    context = build_triage_context(parsed, candidate_causes, session_context)
    parts = [render_context_text(context)]
    if skill_context_text:
        parts.append(skill_context_text)
    parts.append("Explain the likely cause and the first safe check.")
    parts.append(skill_contract.CONTRACT_INSTRUCTION)
    prompt = "\n\n".join(parts)
    spec = {"context": context, "prompt": prompt, "instructions": INSTRUCTIONS, "creds": creds}
    raw = TRIAGE_LOOP(spec)
    out = skill_contract.parse_agent_contract(raw, allowed_skill_names=skill_names)
    out["answer"] = out["answer"][:_MAX_OUTPUT]
    out["skills_offered"] = skill_names or []
    return out


__all__ = ["TRIAGE_LOOP", "build_triage_context", "render_context_text", "interpret",
           "SAFETY_RULES", "INSTRUCTIONS"]
