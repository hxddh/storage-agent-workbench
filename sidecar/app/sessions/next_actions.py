"""Deterministic next-step normaliser.

Used by the deterministic summary builder and the error-triage engine for the
bounded, sanitized "safe next steps" they list. Since v1.12 the Agent runtime
never produces proposals and nothing here prepares or executes anything: the
only confirmation boundary is the gated tool path (``agent_runtime.gated_tools``).
"""


from __future__ import annotations

import uuid
from typing import Any

from ..security.redaction import redact_text

# Action types that have SPECIAL, structured handling in `_resolve` (a confirmed
# data-moving import flow, the session report, a context question, or a known
# run). These are NOT a cap on what the agent may propose — any other concrete
# next step is accepted too (see normalize_proposal) and, when clicked, is simply
# handed back to the agent conversationally. The set below only decides which
# proposals get a purpose-built UI affordance vs. a "ask the agent to do it" path.
# The security-sensitive ones (plan_*_import) MUST stay here so they route through
# the confirm-before-download planner rather than a free-form prompt.
# action_type → what actually executes (the names are internal/audit-only; the
# user only ever sees the proposal title + a localized prompt, never these slugs,
# so they are kept stable rather than renamed). The `run_*` prefix is historical:
# these no longer start a deterministic run — most just hand the request back to
# the conversational agent, which does it with its own read-only tools:
#   run_account_discovery    → agent calls the read-only survey_account tool
#   run_bucket_config_review → agent calls the read-only review_bucket_config tool
#   run_diagnostic           → agent's adaptive test_credentials/addressing/TLS/…
#                              probe chain (NOT execute_diagnostic_run)
#   run_inventory_analysis   → opens the file picker → analyze_uploaded_file
#   run_access_log_analysis  → opens the file picker → analyze_uploaded_file
#   plan_inventory_import    → confirmed evidence-import planner (data-moving)
#   plan_access_log_import   → confirmed evidence-import planner (data-moving)
#   generate_session_report  → renders the saved session report
#   ask_user_for_context     → seeds the composer with a clarifying question
SPECIAL_ACTION_TYPES = {
    "run_account_discovery",
    "run_bucket_config_review",
    "run_diagnostic",
    "plan_inventory_import",
    "plan_access_log_import",
    "run_inventory_analysis",
    "run_access_log_analysis",
    "generate_session_report",
    "ask_user_for_context",
}

# A free-form action_type must still be a safe, bounded slug.
_MAX_ACTION_TYPE_LEN = 64


def _safe_action_type(value: str) -> str | None:
    """Accept any concrete next-step label, sanitized to a bounded slug. The
    agent is no longer capped to a fixed enum — an unrecognized type just routes
    to the conversational path (the agent does it with its own tools).

    Defense in depth: a label that carries a forbidden/destructive token
    (shell, exec, sql, delete-object, put-bucket-policy, …) is still rejected,
    even though no destructive capability exists to execute it — a proposal must
    never even *suggest* a mutating/dangerous operation.
    """
    from ..agent_runtime import guardrails
    slug = "".join(c for c in str(value).strip().lower() if c.isalnum() or c in ("_", "-"))
    slug = slug[:_MAX_ACTION_TYPE_LEN]
    if not slug:
        return None
    if guardrails.is_forbidden_tool(slug):
        return None
    return slug

_CONFIDENCE = {"high", "medium", "low"}


def normalize_proposal(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Coerce an arbitrary proposal dict into the canonical, sanitized shape.

    The agent is NOT capped to a fixed menu: any safe, bounded action_type slug is
    accepted (an unrecognized one just routes to the conversational path). Returns
    None only if the slug is empty or carries a forbidden/destructive token.
    """
    if not isinstance(raw, dict):
        return None
    action_type = _safe_action_type(raw.get("action_type", ""))
    if action_type is None:
        return None
    confidence = str(raw.get("confidence", "medium")).strip().lower()
    if confidence not in _CONFIDENCE:
        confidence = "medium"
    prefill_in = raw.get("prefill") if isinstance(raw.get("prefill"), dict) else {}
    prefill = {k: (redact_text(str(v)) if isinstance(v, str) else v)
               for k, v in prefill_in.items()
               if k in ("bucket", "prefix", "question", "source_type", "bucket_name")}
    source_run_ids = [str(x)[:64] for x in (raw.get("source_run_ids") or []) if x][:20]
    return {
        "id": str(raw.get("id") or f"proposal_{uuid.uuid4().hex[:12]}"),
        # `or ""` (not get(..., "")) so a present-but-null value coerces to "" —
        # str(None) would otherwise become the literal string "None".
        "title": redact_text(str(raw.get("title") or ""))[:160] or action_type.replace("_", " "),
        "reason": redact_text(str(raw.get("reason") or ""))[:400] or None,
        "action_type": action_type,
        "requires_confirmation": True,  # always — proposals never auto-execute
        "confidence": confidence,
        "source_run_ids": source_run_ids,
        "required_inputs": [],
        "prefill": prefill,
        "safety_notes": [],
        "status": "proposed",
    }
