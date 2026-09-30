"""Advice tools (v10): deterministic error triage and storage-class projection.

Neither calls storage or a model. Triage reads only the pasted text (redacted
first) and, when it carries a presigned URL, parses that URL without a request;
the simulation reads the bounded aggregate of an inventory the task already
holds — no dollar figures.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field

from ...analysis import cost_sim
from ...engines import datasets
from ...error_triage import parser, playbooks
from ...s3 import tools as s3
from .registry import current, plural, tool

_MAX_CAUSES = 6
_PRESIGNED = re.compile(r"https?://[^\s\"'<>]+[?&](?:X-Amz-Signature|X-Amz-Credential|Signature|AWSAccessKeyId)="
                        r"[^\s\"'<>]*", re.IGNORECASE)


def _triage_summary(r: Any) -> str:
    if not isinstance(r, dict):
        return "triaged"
    head = str(r.get("error_code") or ("presigned URL" if r.get("presigned_url") else "unrecognized"))
    return f"{head}, {plural(len(r.get('candidate_causes') or []), 'likely cause')}"


@tool(group="advice", core=True, timeout=15, summarize=_triage_summary)
def triage_error(text: str = "", url: str = "") -> dict[str, Any]:
    """Triage a pasted S3 error, SDK exception or log excerpt offline: code, status, candidate causes and
    the checks that would confirm them. A presigned URL (in text or url) is parsed, not requested.

    Args:
        text: As pasted.
    """
    if not (text or "").strip() and not (url or "").strip():
        return {"error": "Nothing to triage: pass the error text (or a presigned URL)."}
    raw = f"{url or ''}\n{text or ''}"
    found = _PRESIGNED.search(raw)
    presigned = s3.diagnose_presigned_url(found.group(0)) if found else None
    # The URL's credential parameters never reach the parser or the result.
    redacted = parser.redact_input(_PRESIGNED.sub("[presigned URL]", text or ""))
    parsed = parser.parse(redacted, "mixed") if redacted.strip() else {}
    causes = []
    skills: list[str] = []
    for e in (playbooks.match(parsed) if parsed else [])[:_MAX_CAUSES]:
        causes.append({"category": e["category"], "confidence": e["confidence"], "title": e["title"],
                       "likely_causes": e["likely_causes"][:5], "evidence_to_check": e["evidence_to_check"][:5],
                       "next_checks": e["next_checks"][:5]})
        skill = playbooks.skill_for_category(e["category"])
        if skill and skill not in skills:
            skills.append(skill)
    if presigned is not None and playbooks.PRESIGNED_SKILL not in skills:
        skills.append(playbooks.PRESIGNED_SKILL)
    signals = {k: parsed.get(k) for k in ("error_code", "http_status", "operation", "method", "region",
                                          "endpoint", "bucket", "request_id", "language")
               if parsed.get(k)}
    return {"success": True, **signals, "candidate_causes": causes, "suggested_skills": skills,
            **({"presigned_url": presigned} if presigned is not None else {}),
            "note": "Based only on the pasted text; no storage call was made."}


def _latest_inventory(conn: Any, task_id: str, dataset_id: str) -> dict[str, Any] | None:
    rows = [d for d in datasets.list_for_task(conn, task_id) if d["dataset_type"] == "inventory"]
    if dataset_id:
        rows = [d for d in rows if d["id"] == dataset_id]
    return rows[-1] if rows else None


class CandidateRule(BaseModel):
    kind: Literal["transition", "expiration", "abort_mpu"]
    days: int = Field(ge=0, le=3650)
    storage_class: str | None = Field(default=None, description="transition: e.g. STANDARD_IA")
    prefix: str | None = None


@tool(group="advice", timeout=300,
      summarize=lambda r: ("gap: " + ", ".join(g.get("code", "") for g in (r or {}).get("gaps") or [])
                           if isinstance(r, dict) and r.get("kind") == "gap" else "simulated")[:160])
def simulate_storage_cost(dataset_id: str = "", candidate_rules: list[CandidateRule] | None = None) -> dict[str, Any]:
    """Project an inventory's bytes per storage class over 0-365 days under the current lifecycle and
    candidate rules. No dollar figures.

    Args:
        dataset_id: The inventory; omit for the newest.
    """
    ctx = current()
    conn = ctx.conn()
    ds = _latest_inventory(conn, ctx.task_id, dataset_id)
    inventory = None
    if ds is not None:
        analysis = datasets.analyze(conn, ds)
        inventory = analysis.get("metrics") or None
    candidates = [r.model_dump(exclude_none=True) if isinstance(r, BaseModel) else r
                  for r in (candidate_rules or [])] or None
    result = cost_sim.simulate(inventory=inventory, candidates=candidates,
                               inventory_as_of=ds["created_at"] if ds else None)
    if ds is not None:
        result["dataset_id"] = ds["id"]
    return result
