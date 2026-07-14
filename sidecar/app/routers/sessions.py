"""Session endpoints.

Sessions are the persistent working context that links runs, evidence, findings,
a deterministic summary, and a lightweight message thread. The session agent is a
read-only tool-calling investigator (bounded, sanitized context; secrets never
reach it) that also keeps working memory. It is always fully autonomous in its
read-only investigation (no autonomy toggle); its own surveys/reviews are
internal compute it narrates, never a surfaced run card. This is NOT a
project-management / kanban / ticketing surface.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import StreamingResponse

from .. import audit, config
from ..agent_runtime import session_agent, turn_guard
from ..agent_runtime.agent_service import AgentUnavailable, get_model_credentials
from ..db import connect, get_conn
from ..models.schemas import (
    ActionRequest,
    SessionCreate,
    SessionDetail,
    SessionDatasetUploadResponse,
    SessionMessageCreate,
    SessionSummary,
    SessionUpdate,
)
from ..repositories import runs as runs_repo
from ..repositories import session_datasets as sds_repo
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
def list_sessions(q: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    """List sessions. With `?q=`, returns sessions whose title or message content
    matches (substring, case-insensitive)."""
    rows = repo.search(conn, q) if q else repo.list_all(conn)
    return [SessionSummary(**s) for s in rows]


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


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(session_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    repo.delete(conn, session_id)
    audit.record(conn, "session.delete", {"session_id": session_id}, run_id=None)
    conn.commit()
    return None


@router.post("/{session_id}/fork", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
def fork_session(session_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    new_id = repo.fork(conn, session_id)
    if new_id is None:
        raise HTTPException(status_code=404, detail="session not found")
    audit.record(conn, "session.fork", {"session_id": session_id, "new_session_id": new_id}, run_id=None)
    conn.commit()
    return _detail(conn, new_id)


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
        raise HTTPException(status_code=422, detail="proposal action_type is missing or carries a forbidden token")
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


_DATASET_TYPES = {"access_log", "inventory"}


def _safe_filename(name: str) -> str:
    base = Path(name or "upload.dat").name
    return base or "upload.dat"


@router.post("/{session_id}/datasets/upload", response_model=SessionDatasetUploadResponse)
async def upload_session_dataset(
    session_id: str,
    file: UploadFile = File(...),
    dataset_type: str = Form(...),
    conn: sqlite3.Connection = Depends(get_conn),
) -> Any:
    """Attach a data file (access log / inventory export) to a session. The file
    is stored locally against the session; the in-chat agent then analyzes it as a
    tool and answers inline — there is no fixed analysis run. Read-only."""
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    if dataset_type not in _DATASET_TYPES:
        raise HTTPException(status_code=422, detail="dataset_type must be 'access_log' or 'inventory'")

    filename = _safe_filename(file.filename or "upload.dat")
    raw_dir = config.data_dir() / "sessions" / session_id / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    dest = raw_dir / filename
    contents = await file.read()
    dest.write_bytes(contents)

    stored_rel = config.rel_path(dest)
    dataset_id = sds_repo.upsert(conn, session_id, dataset_type, filename, stored_rel)
    audit.record(conn, "session.dataset.upload",
                 {"session_id": session_id, "dataset_id": dataset_id,
                  "dataset_type": dataset_type, "bytes": len(contents)}, run_id=None)
    conn.commit()
    return SessionDatasetUploadResponse(
        dataset_id=dataset_id, session_id=session_id, dataset_type=dataset_type,
        filename=filename, status="uploaded",
    )


# How long the blocking fallback waits to ATTACH to a still-running streaming
# worker for the same turn before giving up with a 409 (the worker keeps going).
_IN_PROGRESS_WAIT_S = 150.0


def _result_envelope(cached: dict[str, Any]) -> dict[str, Any]:
    return {
        "proposed_actions": cached.get("proposed_actions", []),
        "skills_used": cached.get("skills_used", []),
        "skills_offered": cached.get("skills_offered", []),
        "evidence_used": cached.get("evidence_used", []),
        "evidence_gaps": cached.get("evidence_gaps", []),
    }


@router.post("/{session_id}/messages")
def post_session_message(
    session_id: str, body: SessionMessageCreate, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    row = repo.get_row(conn, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")

    # Idempotency / attach: this may be the blocking fallback for a turn the
    # streaming attempt is still running (SSE dropped) or already completed.
    #  - completed  → return the persisted result, don't re-run.
    #  - in-progress → WAIT for the SAME worker (up to _IN_PROGRESS_WAIT_S) and
    #    return its result, rather than re-running the turn CONCURRENTLY with the
    #    still-alive worker (which duplicated messages + doubled spend).
    handle, created = turn_guard.begin(body.turn_id, session_id)
    if handle is not None and not created:
        if not handle.done:
            handle.done_event.wait(_IN_PROGRESS_WAIT_S)
        if handle.done:
            if handle.payload is not None:
                return {"session_id": session_id, "messages": repo.list_messages(conn, session_id),
                        **_result_envelope(handle.payload)}
            if handle.failed:
                # The streaming attempt for this turn failed server-side (nothing
                # persisted). Surface its error promptly instead of a bogus 409.
                raise HTTPException(status_code=502,
                                    detail=redact_text(handle.error or "the turn failed"))
        raise HTTPException(status_code=409, detail="turn still in progress")

    # We own this turn (created=True). GUARANTEE the handle is resolved on every
    # exit — otherwise a same-turn_id fallback attaches to a running handle whose
    # done_event is never set and blocks the full _IN_PROGRESS_WAIT_S.
    try:
        # Build the deterministic, sanitized context — independent of any model key.
        # NOTE: the user message is NOT persisted yet. We persist user+assistant
        # together only on success (same as the streaming path), so a clean failure
        # (e.g. no model key → 422) doesn't leave a dangling user message in the
        # thread. answer() takes body.content as the question directly.
        summary = repo.get_summary(conn, session_id) or summary_builder.refresh(conn, session_id)
        recent = repo.list_messages(conn, session_id)
        attachments = sds_repo.list_pending_for_session(conn, session_id)

        try:
            creds = get_model_credentials(conn)  # raises AgentUnavailable if missing
            contract = session_agent.answer(dict(row), summary, recent, body.content, creds, conn,
                                            body.turn_id, attachments=attachments,
                                            cancel_event=(handle.cancel_event if handle else None))
        except AgentUnavailable as exc:
            # Clean failure: nothing is persisted — the user keeps their text and
            # sees the error. Drop the registration so a genuine retry isn't
            # blocked as "in progress".
            turn_guard.discard(body.turn_id)
            raise HTTPException(status_code=422, detail=redact_text(str(exc)))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — any other failure MUST resolve the handle
        turn_guard.fail(body.turn_id, redact_text(str(exc)), session_id)
        raise HTTPException(status_code=500, detail=redact_text(str(exc)))

    # Success: persist the user message and the assistant answer together.
    # The contract is already sanitized + allowlist-coerced inside session_agent.
    proposed_actions = contract["next_action_proposals"]
    grounding = {
        "evidence_used": contract.get("evidence_used", []),
        "evidence_gaps": contract.get("evidence_gaps", []),
        "skills_used": contract.get("skills_used", []),
    }
    repo.add_message(conn, session_id, "user", body.content)
    repo.add_message(conn, session_id, "assistant", contract["answer"],
                     tool_activity=contract.get("tool_activity"),
                     grounding=grounding, proposed_actions=proposed_actions)
    audit.record(conn, "session.message", {"session_id": session_id}, run_id=None)
    conn.commit()
    turn_guard.set_result(body.turn_id, {
        "proposed_actions": proposed_actions,
        "skills_used": contract.get("skills_used", []),
        "skills_offered": contract.get("skills_offered", []),
        "evidence_used": contract.get("evidence_used", []),
        "evidence_gaps": contract.get("evidence_gaps", []),
    }, session_id)
    return {
        "session_id": session_id,
        "messages": repo.list_messages(conn, session_id),
        "proposed_actions": proposed_actions,
        "skills_used": contract.get("skills_used", []),
        "skills_offered": contract.get("skills_offered", []),
        "evidence_used": contract.get("evidence_used", []),
        "evidence_gaps": contract.get("evidence_gaps", []),
        "stopped": contract.get("stopped", False),
    }


@router.post("/{session_id}/turns/{turn_id}/cancel")
def cancel_turn(session_id: str, turn_id: str,
                conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Ask a running turn to stop. Contract (the frontend wires against this):

    - 200 {"status": "cancelling"} — the turn is running; its cancel_event was
      set. The worker observes it, cancels the model run, persists the PARTIAL
      answer, and emits a done event with "stopped": true.
    - 200 {"status": "completed"} — the turn already finished; nothing to cancel.
    - 404 — no such turn is (or was) registered.
    """
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    handle = turn_guard.get_handle(turn_id, session_id)
    if handle is None:
        raise HTTPException(status_code=404, detail="unknown turn")
    if handle.done:
        return {"status": "completed"}
    handle.cancel_event.set()
    audit.record(conn, "session.turn.cancel", {"session_id": session_id, "turn_id": turn_id}, run_id=None)
    conn.commit()
    return {"status": "cancelling"}


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/{session_id}/messages/stream")
async def post_session_message_stream(
    session_id: str, body: SessionMessageCreate, request: Request,
    conn: sqlite3.Connection = Depends(get_conn)
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
    attachments = sds_repo.list_pending_for_session(conn, session_id)

    try:
        creds = get_model_credentials(conn)
    except AgentUnavailable as exc:
        raise HTTPException(status_code=422, detail=redact_text(str(exc)))

    # Register this turn as running (owner of the handle). A blocking fallback
    # for the same turn_id then ATTACHES to this handle instead of re-running,
    # and the cancel endpoint sets this handle's cancel_event.
    handle, created = turn_guard.begin(body.turn_id, session_id)
    if handle is not None and not created:
        # Another attempt already owns this turn_id (running or done). Spawning a
        # second worker would double-run the agent and persist duplicate messages
        # + double model spend. Decline symmetrically with the blocking path: the
        # client falls back to POST /messages, which ATTACHES to the owning
        # attempt (waits for its result) instead of re-running the turn.
        raise HTTPException(status_code=409, detail="turn already in progress")
    cancel_event = handle.cancel_event if handle else None
    # Snapshot the request-scoped reads into plain data so the worker never
    # touches `conn` (the request handler closes it once StreamingResponse is
    # constructed). The worker opens its OWN connection below (fix: request-scoped
    # conn closed under running tools).
    row_d = dict(row)

    # Run the whole agent turn (LLM streaming + any sync tool calls) on a
    # DEDICATED WORKER THREAD with its own event loop, and bridge its events to
    # this response through a thread-safe queue. The agent loop and boto3 tool
    # calls are blocking; running them on the main server event loop would freeze
    # every other request — so one session's run used to stall all the others.
    # Isolating each run on its own thread lets sessions run concurrently.
    main_loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    _DONE = object()

    def emit(item: Any) -> None:
        main_loop.call_soon_threadsafe(queue.put_nowait, item)

    def worker() -> None:
        wloop = asyncio.new_event_loop()
        asyncio.set_event_loop(wloop)
        final: dict[str, Any] = {}
        # The worker owns its OWN sqlite connection for its ENTIRE lifetime —
        # every tool closure binds THIS connection (passed into build_stream) and
        # the final persist uses it too. The request-scoped Depends(get_conn) conn
        # is closed as soon as the handler returns (and torn down on client
        # disconnect); binding tools to it would hit "closed database" mid-run.
        wconn = connect()

        async def drive() -> None:
            # Own the client list so a build_stream failure after a client was
            # created still closes it (stream_events_for, the normal closer, only
            # runs once we reach the async-for below).
            clients: list[Any] = []
            try:
                result, activity, skill_names, finalize, _, budget = session_agent.build_stream(
                    row_d, summary, recent, body.content, creds, wconn, body.turn_id,
                    attachments=attachments, cancel_event=cancel_event, clients=clients)
            except BaseException:
                await session_agent._close_clients(clients)
                raise
            async for kind, data in session_agent.stream_events_for(
                    result, activity, skill_names, finalize,
                    cancel_event=cancel_event, clients=clients, budget=budget):
                if kind == "final":
                    final["data"] = data
                else:
                    emit((kind, data))

        try:
            wloop.run_until_complete(drive())
            data = final.get("data")
            if data is not None:
                stopped = bool(data.get("stopped"))
                try:
                    repo.add_message(wconn, session_id, "user", body.content)
                    mid = repo.add_message(wconn, session_id, "assistant", data["answer"],
                                           tool_activity=data.get("tool_activity"),
                                           grounding={
                                               "evidence_used": data.get("evidence_used", []),
                                               "evidence_gaps": data.get("evidence_gaps", []),
                                               "skills_used": data.get("skills_used", []),
                                           },
                                           proposed_actions=data["next_action_proposals"])
                    audit.record(wconn, "session.message",
                                 {"session_id": session_id, "stopped": stopped}, run_id=None)
                    wconn.commit()
                finally:
                    pass
                # Record the completed turn so the blocking fallback attaches (and
                # won't re-run/re-persist) if the client missed the 'done' event.
                turn_guard.set_result(body.turn_id, {
                    "proposed_actions": data["next_action_proposals"],
                    "skills_used": data.get("skills_used", []),
                    "skills_offered": data.get("skills_offered", []),
                    "evidence_used": data.get("evidence_used", []),
                    "evidence_gaps": data.get("evidence_gaps", []),
                    "stopped": stopped,
                }, session_id)
                emit(("done", {"message_id": mid, "proposed_actions": data["next_action_proposals"],
                               "evidence_used": data.get("evidence_used", []),
                               "evidence_gaps": data.get("evidence_gaps", []),
                               "skills_used": data.get("skills_used", []),
                               "stopped": stopped}))
        except Exception as exc:  # noqa: BLE001
            # Mark FAILED (not just discard) so a blocking fallback parked on this
            # turn's done_event wakes immediately with the error instead of
            # blocking the full _IN_PROGRESS_WAIT_S and reporting a bogus 409.
            turn_guard.fail(body.turn_id, redact_text(str(exc)), session_id)
            emit(("error", redact_text(str(exc))))
        finally:
            # Guarantee the turn handle is resolved on EVERY exit. `except
            # Exception` above misses a BaseException (CancelledError/MemoryError/
            # …) from run_until_complete, and a clean run that yields no final
            # data also never resolves the handle — either way done_event would
            # stay unset, leaking a non-evictable handle and hanging a blocking
            # fallback the full _IN_PROGRESS_WAIT_S. This is a no-op once
            # set_result/fail has already run.
            if handle is not None and not handle.done:
                turn_guard.fail(body.turn_id, "the turn ended unexpectedly", session_id)
            try:
                wconn.close()
            except Exception:  # noqa: BLE001
                pass
            emit(_DONE)
            try:
                wloop.close()
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=worker, name=f"sess-stream-{session_id[:8]}", daemon=True).start()

    async def gen():
        idle = 0.0
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=1.0)
                idle = 0.0
            except asyncio.TimeoutError:
                # No event this second — if the client is gone, stop forwarding.
                # The worker keeps running on its own connection and still
                # persists the turn (and records it in turn_guard) server-side.
                if await request.is_disconnected():
                    break
                # Keepalive during long silent tool calls (e.g. an inline
                # survey run waiting up to _INLINE_RUN_TIMEOUT): an SSE comment
                # resets the client's idle watchdog without emitting an event.
                idle += 1.0
                if idle >= 15.0:
                    idle = 0.0
                    yield ": keepalive\n\n"
                continue
            if item is _DONE:
                break
            kind, data = item
            if kind == "delta":
                yield _sse("delta", {"text": data})
            elif kind == "tool":
                yield _sse("tool", data)
            elif kind == "done":
                yield _sse("done", data)
            elif kind == "error":
                yield _sse("error", {"detail": data})

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
