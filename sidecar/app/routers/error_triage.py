"""Error-triage endpoints (Phase 18).

POST /error-triage runs the deterministic engine (redact → parse → playbooks),
persists a sanitized case bound to the session, and — only in agent mode —
adds an interpretation-only explanation over the SANITIZED triage context.
Triage itself performs NO S3 call, run, download, or mutation. Suggested next
actions are Phase 17 proposals (the user reviews/prepares them).
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .. import audit
from ..agent_runtime.agent_service import AgentUnavailable, get_model_credentials
from ..db import get_conn
from ..error_triage import engine, parser, triage_agent
from ..models.schemas import ErrorTriageRequest, TriageCaseOut
from ..repositories import error_triage as repo
from ..repositories import sessions as sessions_repo
from ..security.redaction import redact_text
from ..sessions import summary_builder

router = APIRouter(tags=["error-triage"])


def _session_context(conn: sqlite3.Connection, session_id: str | None) -> dict[str, Any]:
    if not session_id:
        return {}
    srow = sessions_repo.get_row(conn, session_id)
    if srow is None:
        return {}
    summ = sessions_repo.get_summary(conn, session_id) or {}
    facts = [f.get("text") for f in (summ.get("known_facts") or [])[:8]]
    return {
        "goal": redact_text(str(srow["goal"] or ""))[:300] or None,
        "recent_facts": [redact_text(str(x))[:200] for x in facts if x],
    }


def _to_out(case: dict[str, Any], *, safe_next_actions=None, agent_interpretation=None,
            limitations=None) -> TriageCaseOut:
    return TriageCaseOut(
        id=case["id"], session_id=case.get("session_id"), provider_id=case.get("provider_id"),
        bucket=case.get("bucket"), run_id=case.get("run_id"), input_kind=case["input_kind"],
        raw_input_redacted=case.get("raw_input_redacted"), parsed=case.get("parsed", {}),
        summary=case.get("summary", ""), planner_mode=case.get("planner_mode", "deterministic"),
        status=case.get("status", "triaged"), candidate_causes=case.get("candidate_causes", []),
        safe_next_actions=safe_next_actions or [], agent_interpretation=agent_interpretation,
        limitations=limitations or [], created_at=case.get("created_at"),
        updated_at=case.get("updated_at"),
    )


@router.post("/error-triage", response_model=TriageCaseOut)
def create_triage(body: ErrorTriageRequest, conn: sqlite3.Connection = Depends(get_conn)):
    if body.session_id and sessions_repo.get_row(conn, body.session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")

    # 1) Redact BEFORE anything else. 2) Deterministic analysis (no LLM / no S3).
    redacted = parser.redact_input(body.content)
    result = engine.analyze(redacted, body.input_kind)
    limitations = list(result["limitations"])
    agent_interpretation = None

    # 3) Optional interpretation-only Agent over the SANITIZED triage context.
    if body.planner_mode == "agent":
        try:
            creds = get_model_credentials(conn)  # raises AgentUnavailable if missing
            agent_interpretation = triage_agent.interpret(
                result["parsed"], result["candidate_causes"],
                _session_context(conn, body.session_id), creds)
        except AgentUnavailable as exc:
            # Clean failure: deterministic triage is unaffected; note the limitation.
            limitations.append(f"Agent interpretation unavailable: {redact_text(str(exc))}")

    # 4) Persist the sanitized case + findings (redacted input only).
    case_id = repo.create_case(
        conn, session_id=body.session_id, provider_id=body.provider_id, bucket=body.bucket,
        run_id=None, input_kind=body.input_kind, raw_input_redacted=redacted,
        parsed=result["parsed"], summary=result["summary"], planner_mode=body.planner_mode,
    )
    for f in result["candidate_causes"]:
        repo.add_finding(conn, case_id, f)
    audit.record(conn, "error_triage.case",
                 {"case_id": case_id, "session_id": body.session_id,
                  "error_code": result["parsed"].get("error_code"),
                  "planner_mode": body.planner_mode}, run_id=None)
    conn.commit()

    # 5) Fold the case into the session's deterministic summary.
    if body.session_id:
        try:
            summary_builder.refresh(conn, body.session_id)
        except Exception:  # noqa: BLE001 - never fail triage over session bookkeeping
            pass

    case = repo.get_case(conn, case_id)
    return _to_out(case, safe_next_actions=result["safe_next_actions"],
                   agent_interpretation=agent_interpretation, limitations=limitations)


@router.get("/error-triage/{case_id}", response_model=TriageCaseOut)
def get_triage(case_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    case = repo.get_case(conn, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="triage case not found")
    return _to_out(case, limitations=list(engine._LIMITATIONS))


@router.get("/sessions/{session_id}/error-triage")
def list_session_triage(session_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    if sessions_repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": session_id, "cases": repo.list_for_session(conn, session_id)}
