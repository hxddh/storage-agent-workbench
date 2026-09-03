"""`update_plan` — the one tool through which the Agent states its plan.

Codex parity: a multi-step investigation carries a live checklist the RUNTIME
owns. The model calls ``update_plan`` with the whole list (replace semantics),
the runtime records it as a ``plan.updated`` event and a ``plan`` turn item,
and the transcript shows one checklist card updated in place. The UI never
invents steps: a plan exists only when this tool was called.

Bounded and sanitized: ≤ 12 steps, ≤ 160 chars each, statuses from a fixed
set, redacted like every other model-authored text.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any, TypedDict

from ..security.redaction import redact_text
from .guardrails import strip_chain_of_thought

TOOL_NAME = "update_plan"
MAX_STEPS = 12
MAX_STEP_CHARS = 160
STATUSES = ("pending", "in_progress", "completed")


class PlanStep(TypedDict):
    text: str
    status: str


def normalize_steps(raw: Any) -> list[dict[str, str]]:
    """Coerce whatever the model sent into the bounded plan shape."""
    out: list[dict[str, str]] = []
    if not isinstance(raw, list):
        return out
    for item in raw[:MAX_STEPS]:
        if isinstance(item, str):
            text, status = item, "pending"
        elif isinstance(item, dict):
            text = str(item.get("text") or item.get("step") or "")
            status = str(item.get("status") or "pending").strip().lower()
        else:
            continue
        text = strip_chain_of_thought(redact_text(text)).strip().replace("\n", " ")[:MAX_STEP_CHARS]
        if not text:
            continue
        if status not in STATUSES:
            status = "pending"
        out.append({"text": text, "status": status})
    return out


def build(function_tool: Callable, activity: list[dict[str, Any]] | None) -> list[Any]:
    @function_tool
    def update_plan(steps: list[PlanStep]) -> str:
        """Keep a short plan for work that needs THREE OR MORE distinct steps (skip it for trivial work). Send the WHOLE list every time — it replaces the previous plan — with each step's status: pending, in_progress or completed. Keep exactly one step in_progress while you work and mark steps completed as you finish them; the user sees this as a live checklist. Args: steps (list of {text, status}); at most 12 steps."""
        plan = normalize_steps(steps)
        if not plan:
            return "error: a plan needs at least one step with text"
        done = sum(1 for s in plan if s["status"] == "completed")
        if activity is not None:
            # A plan record rides the activity list so the stream and the
            # runtime see it in order with the tool rows, but it is not a probe:
            # the transcript renders it as the checklist, not as a tool row.
            activity.append({"id": uuid.uuid4().hex, "tool": TOOL_NAME,
                             "target": f"{len(plan)} steps", "result": f"{done}/{len(plan)} done",
                             "ok": True, "status": "completed", "plan": plan})
        return json.dumps({"status": "recorded", "steps": len(plan), "completed": done})

    return [update_plan]
