"""Parse + sanitize the minimal skill-grounded agent output contract.

Used by the conversational session agent (the only LLM). The model MAY append one
fenced JSON block:

    {"answer": "...", "skills_used": [], "evidence_used": [],
     "evidence_gaps": [], "next_action_proposals": []}

Everything is sanitized: answer is redacted + chain-of-thought-stripped; lists
are bounded + redacted; skills_used is restricted to the skills we actually
injected; next_action_proposals are free-form but sanitized to a bounded slug
with forbidden/destructive tokens dropped (all require confirmation). No field is
mandatory — if the model returns plain prose,
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
# Generous cap so large enumerations (e.g. a 96-row bucket table) are never
# truncated in post-processing; the model's own completion budget bounds length.
_MAX_ANSWER = 48000


CONTRACT_INSTRUCTION = (
    "Write your FULL answer as normal prose. If the user asked you to list or "
    "enumerate items, write out EVERY item the tool returned — all N rows, never "
    "a sample or 'first few', never abbreviated with '…'. The prose IS what the "
    "user sees, so a partial list means the user loses data. Finish the entire "
    "list BEFORE you write the JSON block. "
    "Then you MAY append exactly one fenced JSON block with METADATA ONLY (no "
    "answer field):\n"
    "```json\n{\"skills_used\": [\"<skill name>\"], \"evidence_used\": [\"...\"], "
    "\"evidence_gaps\": [\"...\"], \"next_action_proposals\": [{\"title\": \"...\", "
    "\"action_type\": \"...\", \"confidence\": \"low|medium|high\"}]}\n```\n"
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

    # Prefer the human-readable PROSE as the answer (it holds the full content,
    # e.g. an enumerated list); the JSON block is for metadata. Only fall back to
    # the JSON "answer" field when there is no prose outside the block.
    answer_raw = prose if prose.strip() else (data.get("answer") if isinstance(data.get("answer"), str) else "")
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
