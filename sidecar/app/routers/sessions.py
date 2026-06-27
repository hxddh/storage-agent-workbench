"""Session endpoints (Phase 16).

Sessions are the persistent working context that links runs, evidence, findings,
a deterministic summary, and a lightweight message thread. The session assistant
is interpretation-only (no tools, sanitized bounded context). This is NOT a
project-management / kanban / ticketing surface.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse

from .. import audit
from ..agent_runtime import session_agent
from ..agent_runtime.agent_service import AgentUnavailable, get_model_credentials
from ..db import get_conn
from ..models.schemas import (
    ActionRequest,
    SessionCreate,
    SessionDetail,
    SessionMessageCreate,
    SessionSummary,
    SessionUpdate,
)
from ..repositories import runs as runs_repo
from ..repositories import sessions as repo
from ..security.redaction import redact_text
from ..sessions import next_actions, session_report, summary_builder

router = APIRouter(prefix="/sessions", tags=["sessions"])


def _detail(conn: sqlite3.Connection, session_id: str) -> SessionDetail:
    row = repo.get_row(conn, session_id)
    summary = repo.get_summary(conn, session_id)
    return SessionDetail(
        id=row["id"], title=row["title"], goal=row["goal"], provider_id=row["provider_id"],
        primary_bucket=row["primary_bucket"], status=row["status"],
        created_at=row["created_at"], updated_at=row["updated_at"],
        runs=repo.list_runs(conn, session_id),
        findings=[
            {**f, "id": f["id"]} for f in repo.list_findings(conn, session_id)
        ],
        summary=summary,
        messages=repo.list_messages(conn, session_id),
    )


@router.post("", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
def create_session(body: SessionCreate, conn: sqlite3.Connection = Depends(get_conn)):
    session_id = repo.create(conn, body)
    audit.record(conn, "session.create", {"session_id": session_id}, run_id=None)
    conn.commit()
    return _detail(conn, session_id)


@router.get("", response_model=list[SessionSummary])
def list_sessions(conn: sqlite3.Connection = Depends(get_conn)):
    return [SessionSummary(**s) for s in repo.list_all(conn)]


@router.get("/{session_id}", response_model=SessionDetail)
def get_session(session_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    return _detail(conn, session_id)


@router.patch("/{session_id}", response_model=SessionDetail)
def patch_session(session_id: str, body: SessionUpdate, conn: sqlite3.Connection = Depends(get_conn)):
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    repo.update(conn, session_id, body)
    return _detail(conn, session_id)


@router.post("/{session_id}/runs/{run_id}", response_model=SessionDetail)
def attach_run(session_id: str, run_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    run = runs_repo.get_row(conn, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    repo.link_run(conn, session_id, run_id, repo.RUN_ROLE.get(run["run_type"]))
    summary_builder.refresh(conn, session_id)
    audit.record(conn, "session.attach_run", {"session_id": session_id, "run_id": run_id}, run_id=run_id)
    conn.commit()
    return _detail(conn, session_id)


@router.get("/{session_id}/runs")
def list_session_runs(session_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": session_id, "runs": repo.list_runs(conn, session_id)}


@router.get("/{session_id}/summary")
def get_session_summary(session_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    summary = repo.get_summary(conn, session_id)
    if summary is None:
        summary = summary_builder.refresh(conn, session_id)
        summary = repo.get_summary(conn, session_id)
    return summary


@router.post("/{session_id}/refresh-summary")
def refresh_summary(session_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    summary_builder.refresh(conn, session_id)
    return repo.get_summary(conn, session_id)


@router.get("/{session_id}/report")
def get_session_report(session_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    row = repo.get_row(conn, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    summary = repo.get_summary(conn, session_id) or summary_builder.refresh(conn, session_id)
    from ..repositories import error_triage as triage_repo
    content = session_report.render_session_report(
        dict(row), summary, repo.list_runs(conn, session_id),
        triage_cases=triage_repo.list_for_session(conn, session_id))
    return {"session_id": session_id, "format": "markdown", "content": content}


@router.post("/{session_id}/actions/preview")
def preview_action(session_id: str, body: ActionRequest, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Validate + prefill a next-action proposal. NEVER runs, downloads, or confirms."""
    row = repo.get_row(conn, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    proposal = next_actions.normalize_proposal(body.proposal)
    if proposal is None:
        raise HTTPException(status_code=422, detail="proposal action_type is not in the allowlist")
    out = next_actions.preview(conn, dict(row), proposal)
    audit.record(conn, "next_action_previewed",
                 {"session_id": session_id, "action_type": proposal["action_type"]}, run_id=None)
    conn.commit()
    return {"proposal": proposal, **out}


@router.post("/{session_id}/actions/prepare")
def prepare_action(session_id: str, body: ActionRequest, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Turn a proposal into a prefilled hand-over to an existing safe flow.

    It only prepares; it does NOT create a run, download evidence, confirm an
    import, or call S3/LLM. The user opens the prefilled flow and acts.
    """
    row = repo.get_row(conn, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    proposal = next_actions.normalize_proposal(body.proposal)
    if proposal is None:
        raise HTTPException(status_code=422, detail="proposal action_type is not in the allowlist")
    out = next_actions.prepare(conn, dict(row), proposal)
    audit.record(conn, "next_action_prepared",
                 {"session_id": session_id, "action_type": proposal["action_type"], "status": out["status"]},
                 run_id=None)
    if out["status"] == "ready":
        audit.record(conn, "next_action_opened",
                     {"session_id": session_id, "action_type": proposal["action_type"], "open": out["open"]},
                     run_id=None)
    conn.commit()
    return {"proposal": proposal, **out}


@router.get("/{session_id}/messages")
def list_session_messages(session_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": session_id, "messages": repo.list_messages(conn, session_id)}


@router.post("/{session_id}/messages")
def post_session_message(
    session_id: str, body: SessionMessageCreate, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    row = repo.get_row(conn, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")

    # Persist the user message first (sanitized).
    repo.add_message(conn, session_id, "user", body.content)

    # Build the deterministic, sanitized context — independent of any model key.
    summary = repo.get_summary(conn, session_id) or summary_builder.refresh(conn, session_id)
    recent = repo.list_messages(conn, session_id)

    try:
        creds = get_model_credentials(conn)  # raises AgentUnavailable if missing
        contract = session_agent.answer(dict(row), summary, recent, body.content, creds, conn)
    except AgentUnavailable as exc:
        # Clean failure: the user message is kept; no assistant message is stored.
        raise HTTPException(status_code=422, detail=redact_text(str(exc)))

    # The contract is already sanitized + allowlist-coerced inside session_agent.
    proposed_actions = contract["next_action_proposals"]
    repo.add_message(conn, session_id, "assistant", contract["answer"],
                     tool_activity=contract.get("tool_activity"))
    audit.record(conn, "session.message", {"session_id": session_id}, run_id=None)
    conn.commit()
    return {
        "session_id": session_id,
        "messages": repo.list_messages(conn, session_id),
        "proposed_actions": proposed_actions,
        "skills_used": contract.get("skills_used", []),
        "skills_offered": contract.get("skills_offered", []),
        "evidence_used": contract.get("evidence_used", []),
        "evidence_gaps": contract.get("evidence_gaps", []),
    }


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/{session_id}/messages/stream")
async def post_session_message_stream(
    session_id: str, body: SessionMessageCreate, conn: sqlite3.Connection = Depends(get_conn)
):
    """Streaming variant of the message turn (SSE): emits `tool` events as the
    agent investigates, `delta` events as the answer is generated, and a final
    `done` event. Falls back to a 422 (like the blocking path) if no model is
    configured, so the client can use POST /messages instead."""
    row = repo.get_row(conn, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")

    # Build context from the prior thread; the new question goes in via the
    # prompt. Persist nothing until 'final' so that if the stream errors and the
    # client falls back to POST /messages, the turn isn't double-recorded.
    summary = repo.get_summary(conn, session_id) or summary_builder.refresh(conn, session_id)
    recent = repo.list_messages(conn, session_id)

    try:
        creds = get_model_credentials(conn)
        result, activity, skill_names = session_agent.build_stream(
            dict(row), summary, recent, body.content, creds, conn)
    except AgentUnavailable as exc:
        raise HTTPException(status_code=422, detail=redact_text(str(exc)))

    async def gen():
        try:
            async for kind, data in session_agent.stream_events_for(result, activity, skill_names):
                if kind == "delta":
                    yield _sse("delta", {"text": data})
                elif kind == "tool":
                    yield _sse("tool", data)
                elif kind == "final":
                    repo.add_message(conn, session_id, "user", body.content)
                    mid = repo.add_message(conn, session_id, "assistant", data["answer"],
                                           tool_activity=data.get("tool_activity"))
                    audit.record(conn, "session.message", {"session_id": session_id}, run_id=None)
                    conn.commit()
                    yield _sse("done", {"message_id": mid, "proposed_actions": data["next_action_proposals"]})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"detail": redact_text(str(exc))})

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
