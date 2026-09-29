"""Advice tools (v5 registry): deterministic error triage and cost simulation.

Neither calls storage or a model. Triage reads only the pasted text (redacted
first); the simulation reads the bounded aggregate of an inventory the task
already holds and the local price table — dollar figures stay a gap until the
user has confirmed that table against their bill.
"""

from __future__ import annotations

import json
from typing import Any

from ...analysis import cost_sim
from ...engines import datasets
from ...error_triage import parser, playbooks
from .registry import current, tool

_MAX_CAUSES = 6


@tool(group="advice", timeout=15,
      summarize=lambda r: (f"{(r or {}).get('error_code') or 'unrecognized'} · "
                           f"{len((r or {}).get('candidate_causes') or [])} candidate causes")
      if isinstance(r, dict) else "triaged")
def triage_error(text: str) -> dict[str, Any]:
    """Triage a pasted S3 error, SDK exception or log excerpt deterministically: the error code, HTTP
    status, operation, region/endpoint hints, then candidate causes ordered by confidence with the checks
    that would confirm each. No storage call is made; the causes are hypotheses — confirm them with your
    read-only tools before concluding.

    Args:
        text: The error text as the user pasted it (secrets are redacted before parsing).
    """
    redacted = parser.redact_input(text or "")
    parsed = parser.parse(redacted, "mixed")
    causes = []
    skills: list[str] = []
    for e in playbooks.match(parsed)[:_MAX_CAUSES]:
        causes.append({"category": e["category"], "confidence": e["confidence"], "title": e["title"],
                       "likely_causes": e["likely_causes"][:5], "evidence_to_check": e["evidence_to_check"][:5],
                       "next_checks": e["next_checks"][:5]})
        skill = playbooks.skill_for_category(e["category"])
        if skill not in skills:
            skills.append(skill)
    signals = {k: parsed.get(k) for k in ("error_code", "http_status", "operation", "method", "region",
                                          "endpoint", "bucket", "request_id", "language")
               if parsed.get(k)}
    return {"success": True, **signals, "candidate_causes": causes, "suggested_skills": skills,
            "note": "Based only on the pasted text; no storage call was made."}


def _latest_inventory(conn: Any, task_id: str, dataset_id: str) -> dict[str, Any] | None:
    rows = [d for d in datasets.list_for_task(conn, task_id) if d["dataset_type"] == "inventory"]
    if dataset_id:
        rows = [d for d in rows if d["id"] == dataset_id]
    return rows[-1] if rows else None


@tool(group="advice", timeout=300,
      summarize=lambda r: ("gap: " + ", ".join(g.get("code", "") for g in (r or {}).get("gaps") or [])
                           if isinstance(r, dict) and r.get("kind") == "gap" else "simulated")[:160])
def simulate_storage_cost(dataset_id: str = "", candidate_rules_json: str = "") -> dict[str, Any]:
    """Project the storage-class mix (bytes per class) of an inventory this task holds over 0-365 days,
    under the current lifecycle and candidate rules. Estimates carry coverage; a missing inventory is
    returned as a gap. It produces no dollar figures — never invent one.

    Args:
        dataset_id: The inventory dataset (from list_uploaded_files); the latest inventory when not given.
        candidate_rules_json: JSON list of rules, e.g. [{"kind": "transition", "days": 30,
            "storage_class": "STANDARD_IA"}, {"kind": "expiration", "days": 365}].
    """
    ctx = current()
    conn = ctx.conn()
    ds = _latest_inventory(conn, ctx.task_id, dataset_id)
    inventory = None
    if ds is not None:
        analysis = datasets.analyze(conn, ds)
        inventory = analysis.get("metrics") or None
    try:
        candidates = json.loads(candidate_rules_json) if candidate_rules_json else None
    except ValueError:
        return {"error": "candidate_rules_json is not valid JSON."}
    result = cost_sim.simulate(inventory=inventory, candidates=candidates,
                               inventory_as_of=ds["created_at"] if ds else None)
    if ds is not None:
        result["dataset_id"] = ds["id"]
    return result
