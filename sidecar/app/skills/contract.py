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
# The sentinel that OPENS a candidate contract block. The streaming path holds
# back everything from this sentinel until the fence closes and it can decide
# (via is_contract_json) whether the block is the metadata contract or a JSON
# example that belongs in the visible answer.
CONTRACT_SENTINEL = "```json"
# The keys that mark a fenced block as the metadata CONTRACT (vs. a JSON example
# the answer legitimately contains — a bucket policy, CORS/lifecycle rule, etc.).
_CONTRACT_KEYS = frozenset(
    {"answer", "skills_used", "evidence_used", "evidence_gaps", "next_action_proposals"}
)


def is_contract_json(payload: str) -> bool:
    """True if ``payload`` (a fenced block's body) is the metadata contract."""
    try:
        parsed = json.loads(payload)
    except (json.JSONDecodeError, ValueError):
        return False
    return isinstance(parsed, dict) and bool(_CONTRACT_KEYS & parsed.keys())
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
    # The contract is APPENDED, and a domain answer often contains its own earlier
    # ```json examples (bucket policies, CORS/lifecycle rules). Scan blocks from
    # the LAST to the first and pick the last one that actually parses to a dict
    # carrying a known contract key — leaving JSON examples untouched in the prose.
    for m in reversed(list(_BLOCK.finditer(text))):
        try:
            parsed = json.loads(m.group(1))
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(parsed, dict) and (_CONTRACT_KEYS & parsed.keys()):
            data = parsed
            prose = (text[: m.start()] + text[m.end():]).strip()
            break

    # Prefer the human-readable PROSE as the answer (it holds the full content,
    # e.g. an enumerated list); the JSON block is for metadata. Only fall back to
    # the JSON "answer" field when there is no prose outside the block.
    answer_raw = prose if prose.strip() else (data.get("answer") if isinstance(data.get("answer"), str) else "")
    answer = strip_chain_of_thought(redact_text(str(answer_raw or "")))[:_MAX_ANSWER]

    # Cap matches the per-turn read_skill budget (session_tools._MAX_SKILL_LOADS)
    # so a turn that legitimately loaded several skills can report all of them
    # instead of under-reporting its method.
    skills_used = _strlist(data, "skills_used", cap=10, length=80)
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


__all__ = ["parse_agent_contract", "CONTRACT_INSTRUCTION", "CONTRACT_SENTINEL",
           "is_contract_json"]
