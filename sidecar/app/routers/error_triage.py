"""Error-triage endpoints.

POST /error-triage runs the DETERMINISTIC engine (redact → parse → playbooks)
and persists a sanitized case bound to the session. It is the offline,
no-model-key path: it never calls a model, S3, a run, a download, or a mutation.
When a model key IS configured, the conversational agent interprets errors in the
thread — there is no separate triage narrator. Suggested next actions are
proposals (the user reviews/prepares them).
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .. import audit
from ..db import get_conn
from ..error_triage import engine, parser
from ..models.schemas import ErrorTriageRequest, TriageCaseOut
from ..repositories import error_triage as repo
from ..repositories import sessions as sessions_repo
from ..sessions import summary_builder

router = APIRouter(tags=["error-triage"])


def _recompute_safe_actions(case: dict[str, Any]) -> list:
    """Deterministically re-derive the triage proposals from the stored (already
    redacted) input so they survive reload / session-switch.

    We never persist proposals; the engine has no LLM / no S3, so re-running it on
    the stored ``raw_input_redacted`` reproduces the same ``safe_next_actions``.
    Returns [] if the stored input is missing or re-derivation fails (a read must
    never error over this).
    """
    blob = case.get("raw_input_redacted")
    if not blob:
        return []
    try:
        return list(engine.analyze(blob, case.get("input_kind") or "mixed")["safe_next_actions"])
    except Exception:  # noqa: BLE001 - never fail a read over re-derivation
        return []


def _to_out(case: dict[str, Any], *, safe_next_actions=None, limitations=None) -> TriageCaseOut:
    return TriageCaseOut(
        id=case["id"], session_id=case.get("session_id"), provider_id=case.get("provider_id"),
        bucket=case.get("bucket"), run_id=case.get("run_id"), input_kind=case["input_kind"],
        raw_input_redacted=case.get("raw_input_redacted"), parsed=case.get("parsed", {}),
        summary=case.get("summary", ""),
        status=case.get("status", "triaged"), candidate_causes=case.get("candidate_causes", []),
        safe_next_actions=safe_next_actions or [],
        limitations=limitations or [], created_at=case.get("created_at"),
        updated_at=case.get("updated_at"),
    )


@router.post("/error-triage", response_model=TriageCaseOut)
def create_triage(body: ErrorTriageRequest, conn: sqlite3.Connection = Depends(get_conn)):
    if body.session_id and sessions_repo.get_row(conn, body.session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")

    # 1) Redact BEFORE anything else. 2) Deterministic analysis (no LLM / no S3).
    # Triage is the offline, no-model-key path: it parses + matches playbooks and
    # never calls a model. When a key IS configured, the conversational agent is
    # the one that interprets errors (in the thread) — there is no triage narrator.
    redacted = parser.redact_input(body.content)
    result = engine.analyze(redacted, body.input_kind)
    limitations = list(result["limitations"])
    safe_next_actions = list(result["safe_next_actions"])

    # 3) Persist the sanitized case + findings (redacted input only).
    case_id = repo.create_case(
        conn, session_id=body.session_id, provider_id=body.provider_id, bucket=body.bucket,
        run_id=None, input_kind=body.input_kind, raw_input_redacted=redacted,
        parsed=dict(result["parsed"]), summary=result["summary"], planner_mode="deterministic",
    )
    for f in result["candidate_causes"]:
        repo.add_finding(conn, case_id, f)
    audit.record(conn, "error_triage.case",
                 {"case_id": case_id, "session_id": body.session_id,
                  "error_code": result["parsed"].get("error_code")}, run_id=None)
    conn.commit()

    # 5) Fold the case into the session's deterministic summary.
    if body.session_id:
        try:
            summary_builder.refresh(conn, body.session_id)
        except Exception:  # noqa: BLE001 - never fail triage over session bookkeeping
            pass

    case = repo.get_case(conn, case_id)
    return _to_out(case, safe_next_actions=safe_next_actions, limitations=limitations)


@router.get("/error-triage/{case_id}", response_model=TriageCaseOut)
def get_triage(case_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    case = repo.get_case(conn, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="triage case not found")
    return _to_out(case, safe_next_actions=_recompute_safe_actions(case),
                   limitations=list(engine._LIMITATIONS))


@router.get("/sessions/{session_id}/error-triage")
def list_session_triage(session_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    if sessions_repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    # Re-derive proposals + limitations per case so reload / session-switch keeps
    # the clickable next-step chips (they aren't persisted; the engine is
    # deterministic and re-runs on the stored redacted input).
    cases = [
        {**c, "safe_next_actions": _recompute_safe_actions(c),
         "limitations": list(engine._LIMITATIONS)}
        for c in repo.list_for_session(conn, session_id)
    ]
    return {"session_id": session_id, "cases": cases}
