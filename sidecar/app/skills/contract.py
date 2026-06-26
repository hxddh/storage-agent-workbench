"""Parse + sanitize the minimal skill-grounded Agent output contract (Phase 19).

Shared by the session assistant and the triage Agent. The model MAY append one
fenced JSON block:

    {"answer": "...", "skills_used": [], "evidence_used": [],
     "evidence_gaps": [], "next_action_proposals": []}

Everything is sanitized: answer is redacted + chain-of-thought-stripped; lists
are bounded + redacted; skills_used is restricted to the skills we actually
injected; next_action_proposals are coerced through the Phase 17 allowlist (all
require confirmation). No field is mandatory — if the model returns plain prose,
that prose becomes ``answer`` and the remaining fields default to empty lists.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..agent_runtime.guardrails import strip_chain_of_thought
from ..security.redaction import redact_text
from ..sessions import next_actions

_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)
_MAX_ANSWER = 4000


CONTRACT_INSTRUCTION = (
    "After your prose answer you MAY append exactly one fenced JSON block:\n"
    "```json\n{\"answer\": \"...\", \"skills_used\": [\"<skill name>\"], "
    "\"evidence_used\": [\"...\"], \"evidence_gaps\": [\"...\"], "
    "\"next_action_proposals\": [{\"title\": \"...\", \"action_type\": \"...\", "
    "\"confidence\": \"low|medium|high\"}]}\n```\n"
    "skills_used must be chosen ONLY from the provided StorageOps skills. "
    "evidence_used must reference only the provided session/run/finding/triage "
    "evidence. next_action_proposals are PROPOSALS the user must confirm — never "
    "executed by you. Do not include hidden chain-of-thought."
)


def _strlist(data: dict[str, Any], key: str, cap: int = 12, length: int = 300) -> list[str]:
    items = data.get(key)
    if not isinstance(items, list):
        return []
    out: list[str] = []
    for it in items[:cap]:
        s = strip_chain_of_thought(redact_text(str(it)))[:length]
        if s:
            out.append(s)
    return out


def parse_agent_contract(raw: Any, allowed_skill_names: list[str] | None = None) -> dict[str, Any]:
    text = raw if isinstance(raw, str) else str(raw or "")
    data: dict[str, Any] = {}
    prose = text
    m = _BLOCK.search(text)
    if m:
        try:
            parsed = json.loads(m.group(1))
            if isinstance(parsed, dict):
                data = parsed
        except (json.JSONDecodeError, ValueError):
            data = {}
        prose = (text[: m.start()] + text[m.end():]).strip()

    answer_raw = data.get("answer") if isinstance(data.get("answer"), str) and data.get("answer").strip() else prose
    answer = strip_chain_of_thought(redact_text(str(answer_raw or "")))[:_MAX_ANSWER]

    skills_used = _strlist(data, "skills_used", cap=3, length=80)
    if allowed_skill_names is not None:
        allowed = set(allowed_skill_names)
        skills_used = [s for s in skills_used if s in allowed]

    proposals: list[dict[str, Any]] = []
    for raw_p in (data.get("next_action_proposals") or []):
        if isinstance(raw_p, dict):
            norm = next_actions.normalize_proposal(raw_p)
            if norm:
                proposals.append(norm)

    return {
        "answer": answer,
        "skills_used": skills_used,
        "evidence_used": _strlist(data, "evidence_used"),
        "evidence_gaps": _strlist(data, "evidence_gaps"),
        "next_action_proposals": proposals,
    }


__all__ = ["parse_agent_contract", "CONTRACT_INSTRUCTION"]
