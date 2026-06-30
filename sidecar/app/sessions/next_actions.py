"""Next-action hand-over: normalize + prepare.

A next-action proposal is a *suggestion*, never automation. Most proposals are
just handed back to the conversational agent to carry out with its read-only
tools (open stays None → the UI re-asks the agent). Only the genuinely-confirmed
data-moving import (EvidenceImportDialog), the saved session report, and a
context question get a purpose-built flow. This module performs ONLY validation +
prefill: it never creates a run, downloads evidence, confirms an import, calls
S3, calls an LLM, or mutates a bucket. Every proposal carries
``requires_confirmation``; a forbidden/destructive action_type is dropped.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from ..repositories import account_discovery as account_repo
from ..repositories import sessions as sessions_repo
from ..security.redaction import redact_text

# Action types that have SPECIAL, structured handling in `_resolve` (a confirmed
# data-moving import flow, the session report, a context question, or a known
# run). These are NOT a cap on what the agent may propose — any other concrete
# next step is accepted too (see normalize_proposal) and, when clicked, is simply
# handed back to the agent conversationally. The set below only decides which
# proposals get a purpose-built UI affordance vs. a "ask the agent to do it" path.
# The security-sensitive ones (plan_*_import) MUST stay here so they route through
# the confirm-before-download planner rather than a free-form prompt.
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
               if k in ("bucket", "prefix", "question", "source_type")}
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


def _evidence_candidates(conn: sqlite3.Connection, session_id: str, source_type: str) -> list[dict[str, Any]]:
    """Resolve discovered evidence sources of a type from the session's account runs."""
    target = "server_access_logging" if source_type == "access_log" else "inventory"
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for r in sessions_repo.list_runs(conn, session_id):
        if r["run_type"] != "account_discovery" or r["status"] != "completed":
            continue
        profile = account_repo.get_profile(conn, r["run_id"])
        if not profile:
            continue
        for b in profile.get("buckets", []) or []:
            for s in b.get("evidence_sources", []) or []:
                if s.get("source_type") == target and s.get("status") == "available":
                    key = (r["run_id"], b["bucket_name"])
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append({"account_run_id": r["run_id"], "bucket_name": b["bucket_name"]})
    return out


def _resolve(conn: sqlite3.Connection, session: dict[str, Any], proposal: dict[str, Any]) -> dict[str, Any]:
    """Validate + prefill a proposal against session state. NO side effects."""
    action_type = proposal["action_type"]
    session_id = session["id"]

    result: dict[str, Any] = {
        "action_type": action_type,
        "ready": False,
        "open": None,
        "missing_inputs": [],
        "candidates": {},
        "prefill": {},
        "safety_notes": ["This is a proposed next step. Review before starting; nothing runs automatically."],
        "will_create": None,
    }

    # NOTE: there is no "new_run" form. Investigation/diagnosis/config review/
    # account survey and uploaded-file analysis are all things the agent does
    # itself with its read-only tools — clicking such a proposal just passes the
    # request back to the agent conversationally (open stays None). Only the
    # genuinely-confirmed data-moving import, the saved report, and a context
    # question get a purpose-built flow below.
    if action_type in ("plan_inventory_import", "plan_access_log_import"):
        source_type = "inventory" if action_type == "plan_inventory_import" else "access_log"
        cands = _evidence_candidates(conn, session_id, source_type)
        if not cands:
            result["missing_inputs"].append("evidence_source")
            result["safety_notes"].append(
                f"No discovered {source_type} evidence source in this session yet — run account_discovery first.")
        elif len(cands) == 1:
            c = cands[0]
            result.update(ready=True, open="evidence_import",
                          prefill={"source_type": source_type, "account_run_id": c["account_run_id"],
                                   "bucket_name": c["bucket_name"], "session_id": session_id})
            result["safety_notes"].append(
                "Opens the import planner: plan → confirm → run. Nothing downloads until you confirm.")
            if source_type == "access_log":
                result["safety_notes"].append(
                    "Time range, max files, and max bytes are entered in the planner (not auto-filled).")
        else:
            result["missing_inputs"].append("evidence_source")
            result["candidates"] = {"evidence_sources": cands}

    elif action_type == "generate_session_report":
        result.update(ready=True, open="session_report", prefill={"session_id": session_id})
        result["safety_notes"].append("Generates a sanitized session report (no secrets, no raw rows).")

    elif action_type == "ask_user_for_context":
        question = proposal.get("prefill", {}).get("question") or proposal.get("reason") or \
            "Could you share more context about the problem and the affected bucket?"
        result.update(ready=True, open="message_composer", prefill={"question": redact_text(str(question))[:500]})

    if result["missing_inputs"] and not result["ready"]:
        result["status"] = "needs_input"
    else:
        result["status"] = "ready" if result["ready"] else "needs_input"
    return result


def prepare(conn: sqlite3.Connection, session: dict[str, Any], proposal: dict[str, Any]) -> dict[str, Any]:
    r = _resolve(conn, session, proposal)
    return {
        "action_type": r["action_type"],
        "status": r["status"],
        "open": r["open"] if r["ready"] else None,
        "missing_inputs": r["missing_inputs"],
        "candidates": r["candidates"],
        "prefill": r["prefill"] if r["ready"] else {},
        "safety_notes": r["safety_notes"],
    }
