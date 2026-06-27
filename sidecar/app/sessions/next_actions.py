"""Next-action hand-over: normalize, preview, prepare (Phase 17).

A next-action proposal is a *suggestion*, never automation. This module turns a
proposal into a validated, prefilled hand-over that the UI opens in an existing
SAFE flow (NewRunForm / EvidenceImportDialog / session report / message
composer). It performs ONLY validation + prefill: it never creates a run, never
downloads evidence, never confirms an import, never calls S3, never calls an
LLM, and never mutates a bucket. Every proposal carries
``requires_confirmation`` and only an allowlisted action_type survives.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from ..repositories import account_discovery as account_repo
from ..repositories import cloud_providers as cloud_repo
from ..repositories import sessions as sessions_repo
from ..security.redaction import redact_text

# The ONLY action types a proposal may carry. Anything else is dropped/downgraded.
ALLOWED_ACTION_TYPES = {
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

# action_type -> the run_type a "run_*" proposal would create.
_RUN_TYPE = {
    "run_account_discovery": "account_discovery",
    "run_bucket_config_review": "bucket_config_review",
    "run_diagnostic": "diagnostic",
    "run_inventory_analysis": "inventory_analysis",
    "run_access_log_analysis": "access_log_analysis",
}

_CONFIDENCE = {"high", "medium", "low"}


def normalize_proposal(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Coerce an arbitrary proposal dict into the canonical, sanitized shape.

    Returns None if the action_type is not allowlisted (caller drops/downgrades).
    """
    if not isinstance(raw, dict):
        return None
    action_type = str(raw.get("action_type", "")).strip()
    if action_type not in ALLOWED_ACTION_TYPES:
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
        "title": redact_text(str(raw.get("title", "")))[:160] or action_type.replace("_", " "),
        "reason": redact_text(str(raw.get("reason", "")))[:400] or None,
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
    provider_id = session.get("provider_id")
    bucket = session.get("primary_bucket") or proposal.get("prefill", {}).get("bucket")

    # Fall back to the configured cloud provider(s): if the session has none
    # bound and exactly one is configured, use it; otherwise offer them as
    # candidates so the run form can pick. (Chat-created sessions bind none.)
    cloud_list = cloud_repo.list_all(conn)
    provider_candidates = [{"id": p.id, "name": p.name} for p in cloud_list]
    if not provider_id and len(cloud_list) == 1:
        provider_id = cloud_list[0].id

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

    if action_type == "run_account_discovery":
        # Always open the run form; prefill the provider when we have one, else
        # surface providers as candidates so the user can pick in the form.
        result.update(open="new_run", prefill={"run_type": "account_discovery", "session_id": session_id})
        if provider_id:
            result.update(ready=True)
            result["prefill"]["provider_id"] = provider_id
            result["will_create"] = {"run_type": "account_discovery", "session_id": session_id,
                                     "requires_confirmation": True}
        else:
            result["missing_inputs"].append("provider_id")
            result["candidates"] = {"providers": provider_candidates}

    elif action_type in ("run_bucket_config_review", "run_diagnostic"):
        run_type = _RUN_TYPE[action_type]
        result.update(open="new_run", prefill={"run_type": run_type, "session_id": session_id})
        if provider_id:
            result["prefill"]["provider_id"] = provider_id
        else:
            result["missing_inputs"].append("provider_id")
            result["candidates"] = {"providers": provider_candidates}
        if bucket:
            result["prefill"]["bucket"] = bucket
        else:
            result["missing_inputs"].append("bucket")
        if not result["missing_inputs"]:
            result.update(ready=True)
            result["will_create"] = {"run_type": run_type, "session_id": session_id,
                                     "requires_confirmation": True}

    elif action_type in ("run_inventory_analysis", "run_access_log_analysis"):
        run_type = _RUN_TYPE[action_type]
        # Analysis needs an uploaded dataset; open the existing run form (file picker).
        result.update(ready=True, open="new_run",
                      prefill={"run_type": run_type, "session_id": session_id})
        result["will_create"] = {"run_type": run_type, "session_id": session_id, "requires_confirmation": True}
        result["safety_notes"].append("Choose the dataset file in the run form; analysis is local (DuckDB).")

    elif action_type in ("plan_inventory_import", "plan_access_log_import"):
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


def preview(conn: sqlite3.Connection, session: dict[str, Any], proposal: dict[str, Any]) -> dict[str, Any]:
    r = _resolve(conn, session, proposal)
    return {
        "action_type": r["action_type"],
        "ready": r["ready"],
        "missing_inputs": r["missing_inputs"],
        "candidates": r["candidates"],
        "prefill": r["prefill"],
        "safety_notes": r["safety_notes"],
        "will_create": r["will_create"],
    }


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
