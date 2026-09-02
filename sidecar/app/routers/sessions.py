"""Session endpoints — the durable Agent Task compatibility API.

Sessions are the persistent COMPATIBILITY record behind the Agent Task: they
link runs, evidence, findings, a deterministic summary, and the message record.
The session agent is a read-only tool-calling investigator (bounded, sanitized
context; secrets never reach it) that also keeps working memory. This is NOT a
project-management / kanban / ticketing surface.

Since v1.12 there are no message/turn endpoints here: every turn is a durable
Execution submitted through ``/agent-tasks``. This router keeps the task's
durable CRUD, memory, runs linkage, observability, report and dataset
variant streams that execution's durable event log translated into the legacy
`delta`/`tool`/`done`/`error` vocabulary, and turn state/cancel read and act on
durable execution rows. There is exactly one submission lifecycle.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from .. import audit, config
from ..agent_runtime import session_agent
from ..db import get_conn
from ..models.schemas import (
    SessionCreate,
    SessionDetail,
    SessionDatasetUploadResponse,
    SessionMemoryResolve,
    SessionMemoryUpdate,
    SessionSummary,
    SessionUpdate,
)
from ..repositories import model_providers as model_providers_repo
from ..repositories import runs as runs_repo
from ..repositories import session_activity
from ..repositories import session_datasets as sds_repo
from ..repositories import sessions as repo
from ..security.redaction import redact_text
from ..sessions import session_report, summary_builder
from ..task_runtime import artifacts as task_artifacts
from ..task_runtime import store as task_store

router = APIRouter(prefix="/sessions", tags=["sessions"])

# Upper bound on the thread slice handed to the agent for context. The agent
# applies its own elastic cap below this (scaled to the model window); this is
# simply the most it could ever want, so the query never grows with the session.
_CONTEXT_MESSAGES = session_agent._MAX_MESSAGES_CEIL

# The report fetches MORE agent memory than the per-turn context replays: the
# replay cap exists to bound the prompt, and applying it to the auditable
# artifact would silently drop the oldest items. The renderer bounds what it
# prints and states the remainder from the true count.
_REPORT_MEMORY_ROWS = 500


def _safe_err(exc: object) -> str:
    """Redact secrets AND collapse absolute filesystem paths out of an error
    surfaced to the client / SSE — an OSError/sqlite error carries e.g. the app
    DB's absolute path (username included), which `redact_text` alone leaves in."""
    return config.scrub_paths(redact_text(str(exc)))


def _context_messages(conn: sqlite3.Connection) -> int:
    """How many thread messages the agent actually replays, for THIS install's
    configured model.

    Reads only the model name and the operator-declared window — never the API
    key — so the honest "the agent sees the last N of M turns" line in the UI
    costs nothing and leaks nothing. Falls back to the base cap when no provider
    is configured yet (the number the agent would use once one is)."""
    try:
        pid = model_providers_repo.effective_active_id(conn)
        row = conn.execute(
            "SELECT model, context_window FROM model_providers WHERE id = ?", (pid,)
        ).fetchone() if pid else None
        model = row["model"] if row is not None else None
        window = row["context_window"] if row is not None else None
        count, _ = session_agent._elastic_replay_caps(model, window)
        return int(count)
    except Exception:
        return session_agent._MAX_MESSAGES


def _attached_files(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    """The session's attached files, WITHOUT their filesystem paths (the app data
    dir carries the OS username, and this shape is rendered and exported)."""
    keep = ("id", "dataset_type", "source_filename", "detected_format",
            "row_count", "status", "created_at")
    return [{k: d.get(k) for k in keep} for d in sds_repo.list_for_session(conn, session_id)]


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
        # The tail, not the whole thread: a long investigation is worth keeping
        # in one session, but re-sending its entire history on every open (and
        # every turn) grows without bound. `message_total` lets the client offer
        # "load earlier" rather than showing a partial thread as if complete.
        messages=repo.list_messages(conn, session_id, limit=repo.DEFAULT_MESSAGE_PAGE),
        message_total=repo.count_messages(conn, session_id),
        # What the agent knows and holds (v0.51.0). Its own memory is replayed
        # into every later turn, so showing it is the difference between an
        # investigator you can correct and one whose wrong facts steer the rest
        # of the session invisibly.
        agent_memory=repo.list_agent_memory(conn, session_id),
        attached_files=_attached_files(conn, session_id),
        context_messages=_context_messages(conn),
    )


@router.post("", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
def create_session(body: SessionCreate, conn: sqlite3.Connection = Depends(get_conn)):
    session_id = repo.create(conn, body)
    # The durable task row is created WITH the session — the Agent Task is a
    # domain object from birth, not a projection materialized on first read.
    task_store.ensure_task(conn, session_id, body.title, body.goal)
    audit.record(conn, "session.create", {"session_id": session_id}, run_id=None,
                 session_id=session_id)
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
    # Keep the durable task row in step with identity edits and archive state.
    task_store.ensure_task(conn, session_id)
    task_store.sync_task_identity(conn, session_id, title=body.title, goal=body.goal,
                                  archived=(body.status == "archived")
                                  if body.status is not None else None)
    if body.status is not None and body.status != "archived":
        task_store.refresh_task_status(conn, session_id)
    conn.commit()
    return _detail(conn, session_id)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(session_id: str, conn: sqlite3.Connection = Depends(get_conn)):

    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    # Deletes rows AND returns the internal agent-run ids to clean off disk.
    agent_run_ids = repo.delete(conn, session_id)
    # Remove the session's own upload tree (raw files up to 2 GiB each + per-
    # dataset .duckdb) and each internal run's artifact dir — the DB rows are
    # gone, so without this the files become unreachable orphans forever.
    shutil.rmtree(config.data_dir() / "sessions" / session_id, ignore_errors=True)
    for rid in agent_run_ids:
        shutil.rmtree(config.run_dir(rid), ignore_errors=True)
    # Deliberately NOT session-scoped in the column: the session is ceasing to
    # exist, so a session-scoped row could only ever be read back through a
    # session that is gone. The id stays in the payload, where the global audit
    # trail can still answer "what happened to session X".
    audit.record(conn, "session.delete",
                 {"session_id": session_id, "runs_removed": len(agent_run_ids)}, run_id=None)
    conn.commit()
    return None


@router.post("/{session_id}/fork", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
def fork_session(session_id: str, from_message_id: str | None = None,
                 conn: sqlite3.Connection = Depends(get_conn)):
    """Copy a session. With ``from_message_id``, BRANCH from that point in the
    thread instead of copying all of it (v0.61.0) — everything through that
    message comes along and what followed does not.

    An unknown message id is a 404, not a silent whole-session fork: the caller
    asked to branch somewhere specific, and quietly doing something else would
    hand back a session that looks right and is not."""
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    new_id = repo.fork(conn, session_id, up_to_message_id=from_message_id)
    if new_id is not None:
        src = repo.get_row(conn, new_id)
        task_store.ensure_task(conn, new_id, src["title"], src["goal"])
    if new_id is None:
        raise HTTPException(
            status_code=404,
            detail=("message not found in this session" if from_message_id
                    else "session not found"))
    audit.record(conn, "session.fork",
                 {"session_id": session_id, "new_session_id": new_id,
                  "from_message_id": from_message_id or ""},
                 run_id=None, session_id=session_id)
    conn.commit()
    return _detail(conn, new_id)


@router.patch("/{session_id}/memory/{mem_id}", response_model=SessionDetail)
def correct_agent_memory(session_id: str, mem_id: str, body: SessionMemoryUpdate,
                         conn: sqlite3.Connection = Depends(get_conn)):
    """Correct one of the agent's memory items.

    The agent replays its memory into every later turn, so a wrong fact ("bucket
    X is path-style only") silently steers the rest of the investigation. The
    agent can already fix its own items; this gives the person watching the same
    power. Text is redacted by the repository on write, exactly like the agent's
    own writes, and the edit is audited (rule 17)."""
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    if not repo.update_agent_memory(conn, session_id, mem_id, body.text):
        raise HTTPException(status_code=404, detail="memory item not found")
    audit.record(conn, "session.memory_edit",
                 {"session_id": session_id, "memory_id": mem_id,
                  "text": redact_text(body.text)[:200], "by": "user"},
                 run_id=None, session_id=session_id)
    conn.commit()
    return _detail(conn, session_id)


@router.post("/{session_id}/memory/{mem_id}/resolve", response_model=SessionDetail)
def resolve_agent_memory_item(session_id: str, mem_id: str, body: SessionMemoryResolve,
                              conn: sqlite3.Connection = Depends(get_conn)):
    """Close a memory item so it stops being replayed into later turns.

    Resolved, not deleted: the item leaves the active set (and the agent's
    context) but stays in the row for the audit trail."""
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    if not repo.resolve_agent_memory(conn, session_id, mem_id, body.reason):
        raise HTTPException(status_code=404, detail="memory item not found")
    audit.record(conn, "session.memory_resolve",
                 {"session_id": session_id, "memory_id": mem_id,
                  "reason": redact_text(body.reason or "")[:200], "by": "user"},
                 run_id=None, session_id=session_id)
    conn.commit()
    return _detail(conn, session_id)


@router.post("/{session_id}/runs/{run_id}", response_model=SessionDetail)
def attach_run(session_id: str, run_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    run = runs_repo.get_row(conn, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    repo.link_run(conn, session_id, run_id, repo.RUN_ROLE.get(run["run_type"]))
    # First-class Artifact: a user-visible run linked to the task is indexed as
    # an analysis artifact (agent-internal runs stay internal compute).
    if run["origin"] != "agent":
        task_artifacts.record_analysis(conn, session_id, run_id,
                                       run_type=run["run_type"], title=run["title"])
    summary_builder.refresh(conn, session_id)
    audit.record(conn, "session.attach_run", {"session_id": session_id, "run_id": run_id},
                 run_id=run_id, session_id=session_id)
    conn.commit()
    return _detail(conn, session_id)


@router.get("/{session_id}/runs")
def list_session_runs(session_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": session_id, "runs": repo.list_runs(conn, session_id)}


@router.get("/{session_id}/activity")
def get_session_activity(
    session_id: str,
    limit: int | None = None,
    offset: int = 0,
    conn: sqlite3.Connection = Depends(get_conn),
) -> dict[str, Any]:
    """The session's tool calls with sanitized input/output and real durations.

    This is the inspector's timeline source. Rows were sanitized on write, so
    nothing new is exposed here — what changes is that a conversational turn's
    work can finally be retrieved for the session it belongs to. Bounded, and
    the response says so when more exists.
    """
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": session_id,
            **session_activity.list_activity(conn, session_id, limit, offset)}


@router.get("/{session_id}/activity/{call_id}")
def get_session_activity_call(
    session_id: str,
    call_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
) -> dict[str, Any]:
    """ONE tool call, by the id its thread row carries (v0.56.0).

    Since v0.55.0 every activity record in the thread carries the same id as its
    persisted ``tool_calls`` row, which is what makes a row expandable in place —
    the reader can open the call and see the sanitized arguments it was made with
    and the output it returned, the way Codex and Cursor let you open a step.
    Before this, that detail existed only in the inspector's whole-session
    timeline, reachable by scrolling to a guessed time window.

    Scoped to the session in the path: a call id from another session is a 404,
    not a cross-session read. Nothing new is exposed — the row was sanitized on
    write and is the same one ``/activity`` already returns in bulk.
    """
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    row = session_activity.get_call(conn, session_id, call_id)
    if row is None:
        raise HTTPException(status_code=404, detail="tool call not found")
    return row


@router.get("/{session_id}/audit")
def get_session_audit(
    session_id: str,
    limit: int | None = None,
    offset: int = 0,
    conn: sqlite3.Connection = Depends(get_conn),
) -> dict[str, Any]:
    """The session's audit trail (rule 17), readable at last."""
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": session_id,
            **session_activity.list_audit(conn, session_id, limit, offset)}


@router.get("/{session_id}/overview")
def get_session_overview(
    session_id: str, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    """Counts for the inspector's header band, plus per-turn usage rows.

    ``usage.available`` is false when the model endpoint never reported usage —
    the UI must render that as "unavailable", not as zero.
    """
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": session_id, **session_activity.overview(conn, session_id)}


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
    # The report covers the WHOLE investigation, so this is the one caller that
    # genuinely wants the unbounded thread — the renderer bounds it for reading
    # and states when it truncates. (The thread UI and the per-turn context both
    # page; see repo.DEFAULT_MESSAGE_PAGE.)
    overview = session_activity.overview(conn, session_id)
    content = session_report.render_session_report(
        dict(row), summary, repo.list_runs(conn, session_id),
        triage_cases=triage_repo.list_for_session(conn, session_id),
        agent_memory=repo.list_agent_memory(conn, session_id, limit=_REPORT_MEMORY_ROWS),
        memory_totals=repo.count_agent_memory(conn, session_id),
        messages=repo.list_messages(conn, session_id),
        activity=session_activity.list_activity(conn, session_id)["items"],
        usage=overview.get("usage"),
        turn_metrics=overview.get("turns"),
        audit_events=session_activity.list_audit(conn, session_id)["items"],
        attached_files=_attached_files(conn, session_id))
    # Rule 17: report generation is an auditable event.
    audit.record(conn, "session.report",
                 {"session_id": session_id, "bytes": len(content)}, run_id=None,
                 session_id=session_id)
    # First-class Artifact: the rendered report is indexed against the task
    # (deduped on the task-report ref, so re-renders don't stack rows).
    task_artifacts.record_report(conn, session_id, title=f"Task report — {row['title']}"[:200])
    conn.commit()
    return {"session_id": session_id, "format": "markdown", "content": content}


@router.get("/{session_id}/messages")
def list_session_messages(
    session_id: str,
    limit: int | None = None,
    before: int | None = None,
    conn: sqlite3.Connection = Depends(get_conn),
) -> dict[str, Any]:
    if repo.get_row(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    items = repo.list_messages(conn, session_id, limit=limit or repo.DEFAULT_MESSAGE_PAGE,
                               before_rowid=before)
    total = repo.count_messages(conn, session_id)
    return {
        "session_id": session_id,
        "messages": items,
        "total": total,
        # True when older messages exist above this page — never a silent cap.
        "has_more": bool(items) and int(items[0].get("seq") or 0) > _oldest_seq(conn, session_id),
    }


def _oldest_seq(conn: sqlite3.Connection, session_id: str) -> int:
    row = conn.execute(
        "SELECT min(rowid) FROM session_messages WHERE session_id = ?", (session_id,)
    ).fetchone()
    return int(row[0] or 0)


_DATASET_TYPES = {"access_log", "inventory"}


def _safe_filename(name: str) -> str:
    base = Path(name or "upload.dat").name
    # Path("..").name == ".." and Path(".").name == "." — these are directory
    # refs, not filenames: `raw_dir / ".."` resolves to the PARENT dir and the
    # os.replace onto it 500s. Map them (and an empty base) to a safe default.
    if base in ("", ".", ".."):
        return "upload.dat"
    # Rule 14: a filename carrying a secret-shaped string (a log exported as
    # "AKIA…-backup.csv") must not reach disk, SQLite (`stored_path` persists
    # this name verbatim — redacting only the display column left the secret in
    # the adjacent path column), or the prompt. Swap it for a generated name,
    # keeping only a short, clean extension.
    if redact_text(base) != base:
        ext = Path(base).suffix
        if len(ext) > 8 or redact_text(ext) != ext:
            ext = ".dat"
        return "upload-" + uuid.uuid4().hex[:12] + ext
    return base


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
    # Stream to disk in bounded chunks with a total cap (same protection as the
    # /runs upload endpoint): a single `await file.read()` buffered a multi-GB
    # attachment fully in RAM — the sidecar OOM'd on exactly the large inventory
    # files this endpoint invites.
    from .datasets import _UPLOAD_CHUNK, MAX_UPLOAD_BYTES
    # Temp-then-rename (see /runs upload): a mid-stream failure must never leave
    # a truncated file at the final path a dataset row may already reference.
    total = 0
    tmp = dest.with_name(dest.name + f".part-{uuid.uuid4().hex[:8]}")
    try:
        with tmp.open("wb") as fh:
            while True:
                chunk = await file.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"upload exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB limit",
                    )
                fh.write(chunk)
        os.replace(tmp, dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise

    stored_rel = config.rel_path(dest)
    # The session was verified before the (up to 2 GiB) stream; a concurrent
    # DELETE /sessions/{id} could have removed the row + rmtree'd the dir in that
    # window, so the write recreated a now-orphaned tree. Guard the insert: on the
    # FK violation (or a vanished session), delete the just-written file/dir so no
    # orphan tree is left, and return a clean 409 instead of a 500.
    try:
        if repo.get_row(conn, session_id) is None:
            raise sqlite3.IntegrityError("session deleted during upload")
        dataset_id = sds_repo.upsert(conn, session_id, dataset_type, filename, stored_rel)
    except sqlite3.IntegrityError:
        dest.unlink(missing_ok=True)
        shutil.rmtree(config.data_dir() / "sessions" / session_id, ignore_errors=True)
        raise HTTPException(status_code=409, detail="session was deleted during the upload") from None
    audit.record(conn, "session.dataset.upload",
                 {"session_id": session_id, "dataset_id": dataset_id,
                  "dataset_type": dataset_type, "bytes": total}, run_id=None,
                 session_id=session_id)
    conn.commit()
    return SessionDatasetUploadResponse(
        dataset_id=dataset_id, session_id=session_id, dataset_type=dataset_type,
        filename=filename, status="uploaded",
    )
