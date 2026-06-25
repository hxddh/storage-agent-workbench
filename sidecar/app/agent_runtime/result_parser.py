"""Parse + sanitize the agent's final output (Phase 07).

The agent is asked for JSON {summary, findings[], report_narrative}. This module
validates and sanitizes that into a safe structure, dropping any hidden
chain-of-thought and redacting secret-shaped content.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from ..security.redaction import redact_text
from .guardrails import strip_chain_of_thought

MAX_FINDINGS = 50


@dataclass
class AgentResult:
    summary: str
    findings: list[dict[str, str]] = field(default_factory=list)
    report_narrative: str = ""


def parse_agent_output(raw: Any) -> AgentResult:
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"summary": raw, "findings": [], "report_narrative": raw}
    elif isinstance(raw, dict):
        data = raw
    else:
        data = {}

    summary = strip_chain_of_thought(redact_text(str(data.get("summary", ""))))
    narrative = redact_text(str(data.get("report_narrative", "")))[:4000]

    findings: list[dict[str, str]] = []
    for f in (data.get("findings") or [])[:MAX_FINDINGS]:
        if not isinstance(f, dict):
            continue
        findings.append({
            "severity": str(f.get("severity", "info"))[:32],
            "title": redact_text(str(f.get("title", "")))[:200],
            "detail": redact_text(str(f.get("detail", "")))[:1000],
        })

    return AgentResult(summary=summary, findings=findings, report_narrative=narrative)
