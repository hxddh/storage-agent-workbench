"""`record_conclusion` — the one tool through which the Agent states its result.

v2.0 result-first Task: the Task page opens on the latest Work Result's
conclusion — a short answer, the findings that carry it (each with a
severity), and the next steps — instead of on the tail of a transcript. The
UI never guesses that structure from prose: a conclusion exists only when the
model called this tool, and it is recorded by the RUNTIME (a
``conclusion.recorded`` event, persisted on the assistant message and on the
durable ``work_results`` row). Evidence and gaps are NOT model-claimed here;
they stay derived from the tool trace (``finalize._grounding_from_activity``).

Replace semantics like ``update_plan``: the last call of a turn wins.
Bounded and sanitized: answer ≤ 400 chars; ≤ 8 findings (title ≤ 140,
detail ≤ 400, severity from a fixed set); ≤ 4 next steps (≤ 160 chars);
every string redacted and stripped of hidden reasoning.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

# pydantic refuses `typing.TypedDict` below Python 3.12; typing_extensions' is
# accepted everywhere. Every field is required: the SDK's strict schema wants it.
from typing_extensions import TypedDict

from ..security.redaction import redact_text
from .guardrails import strip_chain_of_thought

TOOL_NAME = "record_conclusion"
MAX_ANSWER_CHARS = 400
MAX_FINDINGS = 8
MAX_FINDING_TITLE = 140
MAX_FINDING_DETAIL = 400
MAX_NEXT_STEPS = 4
MAX_NEXT_STEP_CHARS = 160
SEVERITIES = ("high", "medium", "low", "info")
_SEVERITY_ALIASES = {"critical": "high", "warning": "medium", "warn": "medium",
                     "moderate": "medium", "minor": "low", "none": "info", "ok": "info"}


class ConclusionFinding(TypedDict):
    title: str
    severity: str
    detail: str


def _clean(text: Any, limit: int, *, one_line: bool = True) -> str:
    out = strip_chain_of_thought(redact_text(str(text or ""))).strip()
    if one_line:
        out = " ".join(out.split())
    return out[:limit]


def _severity(raw: Any) -> str:
    value = str(raw or "info").strip().lower()
    value = _SEVERITY_ALIASES.get(value, value)
    return value if value in SEVERITIES else "info"


def normalize(answer: Any, findings: Any, next_steps: Any) -> dict[str, Any] | None:
    """Coerce whatever the model sent into the bounded conclusion shape, or
    None when there is no answer to anchor it."""
    text = _clean(answer, MAX_ANSWER_CHARS)
    if not text:
        return None
    out_findings: list[dict[str, str]] = []
    # Cap what we READ (a runaway list) and what we KEEP (after empties drop).
    for item in (findings if isinstance(findings, list) else [])[:MAX_FINDINGS * 4]:
        if len(out_findings) >= MAX_FINDINGS:
            break
        if isinstance(item, str):
            title, severity, detail = item, "info", ""
        elif isinstance(item, dict):
            title = item.get("title") or item.get("text") or ""
            severity = item.get("severity")
            detail = item.get("detail") or ""
        else:
            continue
        title = _clean(title, MAX_FINDING_TITLE)
        if not title:
            continue
        finding = {"title": title, "severity": _severity(severity)}
        detail = _clean(detail, MAX_FINDING_DETAIL, one_line=False)
        if detail:
            finding["detail"] = detail
        out_findings.append(finding)
    steps: list[str] = []
    for item in (next_steps if isinstance(next_steps, list) else [])[:MAX_NEXT_STEPS * 4]:
        if len(steps) >= MAX_NEXT_STEPS:
            break
        step = _clean(item, MAX_NEXT_STEP_CHARS)
        if step:
            steps.append(step)
    return {"answer": text, "findings": out_findings, "next_steps": steps}


def bounded(raw: Any) -> dict[str, Any] | None:
    """Re-validate a stored/passed-through conclusion at a persistence
    boundary (defense in depth; the tool already normalized it)."""
    if not isinstance(raw, dict):
        return None
    return normalize(raw.get("answer"), raw.get("findings"), raw.get("next_steps"))


def latest(activity: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The turn's conclusion: the last completed call wins."""
    for record in reversed(activity or []):
        if record.get("tool") == TOOL_NAME and record.get("status") != "started":
            return bounded(record.get("conclusion"))
    return None


def build(function_tool: Callable, activity: list[dict[str, Any]] | None) -> list[Any]:
    @function_tool
    def record_conclusion(answer: str, findings: list[ConclusionFinding],
                          next_steps: list[str]) -> str:
        """Record this turn's conclusion once, right before your final answer (investigations, reviews, estimates). answer: one or two sentences; findings: [{title, severity: high|medium|low|info, detail}], most severe first; next_steps: up to 4 follow-ups. Only what your tool results showed."""
        conclusion = normalize(answer, findings, next_steps)
        if conclusion is None:
            return "error: a conclusion needs a non-empty answer"
        if activity is not None:
            # Rides the activity list in order with the tool rows, but it is
            # not a probe: it becomes the Work Result's conclusion, not a row.
            activity.append({"id": uuid.uuid4().hex, "tool": TOOL_NAME,
                             "target": f"{len(conclusion['findings'])} findings",
                             "result": "recorded", "ok": True, "status": "completed",
                             "conclusion": conclusion})
        return json.dumps({"status": "recorded", "findings": len(conclusion["findings"]),
                           "next_steps": len(conclusion["next_steps"])})

    return [record_conclusion]
