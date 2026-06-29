"""Deterministic error-triage engine (Phase 18).

Runs the deterministic pipeline: redact → parse → match playbooks → candidate
causes + safe next checks + next-action proposals. It performs NO S3 call, run,
download, or mutation, and calls no LLM. Triage is deterministic-only — there is
no in-run triage narrator; the conversational session agent interprets a case if
the user asks, and even then only ever sees the sanitized triage context
produced here (never the raw blob).
"""

from __future__ import annotations

from typing import Any

from ..sessions import next_actions
from . import parser, playbooks

_SEVERITY = {
    "auth": "warning", "authz": "warning", "routing": "warning", "throttling": "warning",
    "availability": "warning", "connectivity": "warning", "client": "info", "unknown": "info",
}
MAX_CAUSES = 6

_LIMITATIONS = [
    "Deterministic triage is based ONLY on the pasted (redacted) text; no S3 call was made.",
    "Candidate causes are rule-based and ordered by confidence — they are hypotheses, not verified facts.",
    "Next actions are proposals; nothing runs, downloads, or changes configuration automatically.",
]


def analyze(redacted_input: str, input_kind: str = "mixed") -> dict[str, Any]:
    """Deterministic triage. Returns parsed signals + candidate causes + proposals."""
    parsed = parser.parse(redacted_input, input_kind)
    entries = playbooks.match(parsed)[:MAX_CAUSES]

    candidate_causes: list[dict[str, Any]] = []
    raw_proposals: list[dict[str, Any]] = []
    for e in entries:
        candidate_causes.append({
            "category": e["category"],
            "severity": _SEVERITY.get(e["category"], "info"),
            "confidence": e["confidence"],
            "title": e["title"],
            "interpretation": "Likely causes: " + "; ".join(e["likely_causes"]),
            "evidence": e["evidence_to_check"],
            "next_checks": e["next_checks"],
            "source_refs": [e["code"]] if e.get("code") else [],
        })
        for p in e.get("proposals", []):
            raw_proposals.append({**p, "source_run_ids": []})

    # Normalize + dedupe proposals via the Phase 17 allowlist (proposals only).
    seen: set[str] = set()
    safe_next_actions: list[dict[str, Any]] = []
    for raw in raw_proposals:
        norm = next_actions.normalize_proposal(raw)
        if norm and norm["action_type"] not in seen:
            seen.add(norm["action_type"])
            safe_next_actions.append(norm)

    code = parsed.get("error_code")
    http = parsed.get("http_status")
    top = candidate_causes[0]["title"] if candidate_causes else "no candidate causes"
    bits = []
    if code:
        bits.append(code)
    if http:
        bits.append(f"HTTP {http}")
    head = ", ".join(bits) or "unrecognized error"
    summary = f"Parsed {head}; {len(candidate_causes)} candidate cause(s). Top: {top}."

    return {
        "parsed": parsed,
        "summary": summary,
        "candidate_causes": candidate_causes,
        "safe_next_actions": safe_next_actions,
        "limitations": list(_LIMITATIONS),
    }
