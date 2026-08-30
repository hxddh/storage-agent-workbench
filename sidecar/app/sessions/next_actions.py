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


def project_impact(conn: sqlite3.Connection | None, task_id: str | None,
                   decision: dict[str, Any]) -> dict[str, Any]:
    """Project confirmation bounds for a Decision card.

    Pure presentation: bucket/prefix/source from the stored proposal/prefill,
    file/byte counts from a matching evidence-import plan when one exists,
    and an explicit why-this-needs-confirmation line. Never invents counts.
    """
    proposal = decision.get("proposal") if isinstance(decision.get("proposal"), dict) else {}
    prefill = proposal.get("prefill") if isinstance(proposal.get("prefill"), dict) else {}
    action = str(decision.get("action_type") or proposal.get("action_type") or "")
    bucket = (prefill.get("bucket") or prefill.get("bucket_name")
              or None)
    if isinstance(bucket, str):
        bucket = redact_text(bucket)[:200] or None
    else:
        bucket = None
    prefix = prefill.get("prefix")
    prefix = redact_text(str(prefix))[:200] or None if prefix else None
    source_type = prefill.get("source_type")
    source_type = str(source_type) if source_type else None

    if action in ("plan_inventory_import", "plan_access_log_import"):
        gate = "cloud_download"
        why = (decision.get("reason") or proposal.get("reason")
               or "Moves object bytes from the configured bucket onto this machine. "
                  "Nothing downloads until you confirm the bounded plan.")
        if not source_type:
            source_type = "inventory" if action == "plan_inventory_import" else "access_log"
    elif action == "generate_session_report":
        gate = "artifact_write"
        why = (decision.get("reason") or proposal.get("reason")
               or "Writes a durable sanitized report artifact for this task.")
    else:
        gate = "confirmation"
        why = decision.get("reason") or proposal.get("reason") or "Requires an explicit decision before the Agent continues."

    file_count = None
    total_bytes = None
    scan_scope = None
    if conn is not None and task_id and action in ("plan_inventory_import", "plan_access_log_import"):
        plan = _matching_import_plan(conn, task_id, source_type, bucket)
        if plan is not None:
            file_count = int(plan.get("selected_file_count") or 0) or int(plan.get("planned_file_count") or 0) or None
            total_bytes = int(plan.get("selected_total_bytes") or 0) or int(plan.get("planned_total_bytes") or 0) or None
            scan_scope = _scan_scope_line(plan.get("source_prefix") or prefix,
                                          plan.get("max_files"), plan.get("max_bytes"),
                                          plan.get("time_range_start"), plan.get("time_range_end"))
            if not bucket:
                bucket = redact_text(str(plan.get("source_bucket") or ""))[:200] or None
            if not prefix and plan.get("source_prefix"):
                prefix = redact_text(str(plan.get("source_prefix")))[:200] or None
    if scan_scope is None:
        scan_scope = _scan_scope_line(prefix, None, None, None, None)

    return {
        "gate": gate,
        "why": redact_text(str(why))[:400] if why else None,
        "bucket": bucket,
        "prefix": prefix,
        "source_type": source_type,
        "file_count": file_count,
        "total_bytes": total_bytes,
        "scan_scope": scan_scope,
    }


def _scan_scope_line(prefix: str | None, max_files: Any, max_bytes: Any,
                     time_start: Any, time_end: Any) -> str | None:
    parts: list[str] = []
    if prefix:
        parts.append(f"prefix {prefix}")
    if max_files:
        parts.append(f"max {int(max_files)} files")
    if max_bytes:
        parts.append(f"max {int(max_bytes)} bytes")
    if time_start or time_end:
        parts.append(f"range {time_start or '…'} → {time_end or '…'}")
    return "; ".join(parts) if parts else None


def _matching_import_plan(conn: sqlite3.Connection, task_id: str,
                          source_type: str | None, bucket: str | None) -> dict[str, Any] | None:
    """Latest evidence-import plan linked to this task, optionally matching
    source type / bucket. Absence is a gap, not a fabricated count."""
    sql = (
        "SELECT ei.planned_file_count, ei.planned_total_bytes, ei.selected_file_count, "
        "ei.selected_total_bytes, ei.max_files, ei.max_bytes, ei.source_prefix, "
        "ei.source_bucket, ei.source_type, ei.time_range_start, ei.time_range_end, ei.status "
        "FROM evidence_imports ei "
        "JOIN session_runs sr ON sr.run_id = ei.account_run_id "
        "WHERE sr.session_id = ?"
    )
    params: list[Any] = [task_id]
    if source_type:
        sql += " AND ei.source_type = ?"
        params.append(source_type)
    if bucket:
        sql += " AND ei.source_bucket = ?"
        params.append(bucket)
    sql += " ORDER BY ei.rowid DESC LIMIT 1"
    try:
        row = conn.execute(sql, params).fetchone()
    except Exception:  # noqa: BLE001 — table may be absent in a narrow test DB
        return None
    return dict(row) if row else None


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
