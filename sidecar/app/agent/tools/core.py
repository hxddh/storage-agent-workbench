"""Core tools (v5 registry): skills, the estate, the conclusion."""

from __future__ import annotations

from typing import Any

from ...estate import store as estate
from ...skills import context as skill_context
from ..recorder import Finding
from .registry import current, tool


@tool(group="core", core=True, untrusted=False, timeout=15,
      summarize=lambda r: "loaded" if isinstance(r, str) else str((r or {}).get("error", "loaded"))[:80])
def read_skill(name: str) -> Any:
    """Load the full method of a StorageOps expert skill by name. Pick a name from the skills catalog in
    your instructions; apply the method with your read-only tools.

    Args:
        name: The skill name, e.g. storageops-security-iam-policy.
    """
    ctx = current()
    if not ctx.budget("loads", 20):
        return {"error": "Skill-load budget for this turn is used up (20). Apply the skills already loaded."}
    body = skill_context.read_skill_text(name)
    if body is None:
        return {"error": "Unknown skill. Use a name from the skills catalog."}
    return body


@tool(group="core", core=True, timeout=15)
def query_estate(provider_id: str = "", bucket: str = "", status: str = "active") -> dict[str, Any]:
    """What earlier work established about the storage estate: known buckets (region, posture flags, when
    last checked) and issues with their lifecycle (open, fix proposed, resolved, came back, accepted).
    Re-check before relying on an old observation.

    Args:
        provider_id: Narrow to one provider.
        bucket: Narrow to one bucket.
        status: Issue status: active, care, all, open, fix_proposed, resolved, recurred, accepted.
    """
    conn = current().conn()
    lang = current().turn.lang
    if status not in ("active", "care", "all", *estate.STATUSES):
        status = "active"
    known = estate.buckets(conn, provider_id or None, limit=300)
    if bucket:
        known = [b for b in known if b["bucket"] == bucket]
    return {"success": True, "buckets": known[:200], "bucket_count": len(known),
            "issues": estate.list_issues(conn, status=status, provider_id=provider_id or None,
                                         bucket=bucket or None, limit=100, lang=lang)}


@tool(group="core", core=True, untrusted=False, special="conclusion", timeout=10)
def record_conclusion(answer: str, findings: list[Finding], next_steps: list[str]) -> str:
    """Record the conclusion of an investigation, diagnosis, review or estimate — once, right before your
    final answer. The user sees it at the top of the task.

    Args:
        answer: The direct answer in one or two sentences (at most 400 characters).
        findings: The findings that support it, most severe first (at most 8); severity is high, medium, low or info.
        next_steps: Up to four next steps the user can ask you to take.
    """
    return "recorded"  # handled by the registry (special="conclusion")
