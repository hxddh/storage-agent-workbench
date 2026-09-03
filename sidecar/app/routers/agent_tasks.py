"""Agent Task runtime API — the product-level task surface.

The Agent Task is a durable domain object and this router is its front door:
task list/state, Execution submit/steer/stop/resume, the durable structured
event stream (resumable by sequence number), first-class Decisions, the
Artifact index, Work Results, and the typed Storage Task Context.

Compatibility: the summary rows keep the historical Session-summary shape
(``AgentTaskSummary``) so existing clients keep working; ``requires_decision``
now reads the durable ``task_decisions`` table instead of re-parsing the latest
message, and ``task_status`` / ``active_execution_id`` are additive.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import audit
from ..agent_runtime.agent_service import AgentUnavailable
from ..db import get_conn
from ..models.schemas import SessionSummary
from ..repositories import sessions as sessions_repo
from ..security.redaction import redact_text
from ..task_runtime import context as task_context
from ..task_runtime import event_stream, provenance, runtime, store

router = APIRouter(prefix="/agent-tasks", tags=["agent-tasks"])


class AgentTaskSummary(SessionSummary):
    """Durable Session summary projected into product-level Agent task state."""

    requires_decision: bool = False
    task_status: str = store.TASK_READY
    active_execution_id: str | None = None


class ExecutionCreate(BaseModel):
    direction: str = Field(min_length=1, max_length=32000)
    turn_id: str | None = Field(default=None, max_length=64)
    kind: str | None = Field(default=None, max_length=32)


class SteerRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


class DecisionResolve(BaseModel):
    resolution: str = Field(pattern="^(approved|declined)$")
    note: str | None = Field(default=None, max_length=1000)
    # once (default) | task — "allow for this task" auto-approves later calls of
    # the same action_type in this task.
    scope: str | None = Field(default=None, pattern="^(once|task)$")


def _task_or_404(conn: sqlite3.Connection, task_id: str) -> dict[str, Any]:
    row = sessions_repo.get_row(conn, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    task = store.get_task(conn, task_id)
    if task is None:
        store.ensure_task(conn, task_id, row["title"], row["goal"])
        conn.commit()
        task = store.get_task(conn, task_id)
    return task  # type: ignore[return-value]


@router.get("", response_model=list[AgentTaskSummary])
def list_agent_tasks(q: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    # App-open catch-up: due revisits submit through the ONE runtime path.
    # Cheap when nothing is due; AgentUnavailable skips rather than failing the list.
    try:
        from ..task_runtime import revisit as revisit_mod
        revisit_mod.tick(conn=conn)
    except Exception:
        pass
    rows = sessions_repo.search(conn, q) if q else sessions_repo.list_all(conn)
    ids = [row["id"] for row in rows]
    decisions = store.pending_decision_tasks(conn, ids)
    tasks: dict[str, dict[str, Any]] = {}
    if ids:
        ph = ",".join("?" * len(ids))
        tasks = {r["id"]: dict(r) for r in conn.execute(
            f"SELECT id, status, active_execution_id FROM agent_tasks WHERE id IN ({ph})",
            ids).fetchall()}
    out = []
    for row in rows:
        t = tasks.get(row["id"]) or {}
        out.append(AgentTaskSummary(
            **{**row,
               "requires_decision": decisions.get(row["id"], False),
               "task_status": t.get("status") or store.TASK_READY,
               "active_execution_id": t.get("active_execution_id")}))
    return out


@router.get("/{task_id}/state")
def get_task_state(task_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Everything a client needs to (re)attach after a reload, task switch, or
    sidecar restart — derived from durable rows, so it is true in every one of
    those cases: current status, the active execution (with the durable event
    cursor to resume its stream from), pending decisions, context version."""
    task = _task_or_404(conn, task_id)
    active = store.active_execution(conn, task_id)
    last_seq = 0
    if active is not None:
        row = conn.execute(
            "SELECT MAX(seq) FROM execution_events WHERE execution_id = ?",
            (active["id"],)).fetchone()
        last_seq = int(row[0] or 0)
    last_execution = None
    executions = store.list_executions(conn, task_id, limit=50)
    if executions:
        last_execution = executions[-1]
    active_id = active["id"] if active else None
    queued = [e for e in executions
              if e.get("status") == store.EXEC_QUEUED and e.get("id") != active_id]
    pending = store.list_decisions(conn, task_id, status=store.DECISION_PENDING)
    return {
        "task_id": task_id,
        "status": store.derive_task_status(conn, task_id)
        if task.get("status") != store.TASK_ARCHIVED else store.TASK_ARCHIVED,
        "active_execution": active,
        "last_event_seq": last_seq,
        "last_execution": last_execution,
        "queued_executions": queued,
        "pending_decisions": [_with_impact(conn, task_id, d) for d in pending],
        "context_version": int(task.get("context_version") or 0),
    }


def _with_impact(conn: sqlite3.Connection, task_id: str,
                 decision: dict[str, Any]) -> dict[str, Any]:
    out = dict(decision)
    proposal = decision.get("proposal") if isinstance(decision.get("proposal"), dict) else {}
    if isinstance(proposal.get("impact"), dict):
        # An inline approval projected its impact when the tool raised it
        # (bounded plan counts, bucket, prefix) — that projection is the truth.
        out["impact"] = proposal["impact"]
    else:
        # A pre-1.11 proposal-derived row: nothing was planned, say so.
        out["impact"] = {"gate": "confirmation", "why": decision.get("reason"),
                         "bucket": None, "prefix": None, "source_type": None,
                         "file_count": None, "total_bytes": None, "scan_scope": None}
    return out


# --- executions -----------------------------------------------------------------


@router.post("/{task_id}/executions", status_code=status.HTTP_201_CREATED)
def create_execution(task_id: str, body: ExecutionCreate,
                     conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Delegate a Direction: create (or attach to) a durable execution. A
    duplicate turn_id returns the existing execution with ``created: false`` —
    idempotent submission is a durable guarantee here, not an in-process one."""
    _task_or_404(conn, task_id)
    existing = (store.get_execution_by_turn(conn, task_id, body.turn_id)
                if body.turn_id else None)
    if existing is not None:
        return {"execution": existing, "created": False}
    try:
        kind = (body.kind or "direction").strip().lower()
        # v1.13 — unknown kinds are a client bug, not a direction: 422 instead
        # of silently running an ordinary investigation for a misspelled kind.
        if kind not in ("direction", "verify", "revisit"):
            raise HTTPException(status_code=422, detail=f"unknown execution kind: {body.kind!r}")
        execution = runtime.submit(conn, task_id, body.direction, body.turn_id,
                                   kind=kind)
    except AgentUnavailable as exc:
        raise HTTPException(status_code=422, detail=redact_text(str(exc)))
    return {"execution": execution, "created": True}


@router.get("/{task_id}/executions")
def list_executions(task_id: str, limit: int = 50,
                    conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    return {"task_id": task_id,
            "executions": store.list_executions(conn, task_id, limit=limit)}


@router.get("/{task_id}/executions/{execution_id}")
def get_execution(task_id: str, execution_id: str,
                  conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    execution = store.get_execution(conn, execution_id)
    if execution is None or execution["task_id"] != task_id:
        raise HTTPException(status_code=404, detail="execution not found")
    return execution


@router.get("/{task_id}/executions/{execution_id}/events")
async def stream_execution_events(task_id: str, execution_id: str, after: int = 0,
                                  deltas: bool = True,
                                  conn: sqlite3.Connection = Depends(get_conn)):
    """The execution's structured progress as SSE: durable events replayed from
    ``after`` (every frame carries ``id: <seq>``), live deltas riding along.
    Disconnecting changes nothing server-side; reconnect with the last seq."""
    _task_or_404(conn, task_id)
    execution = store.get_execution(conn, execution_id)
    if execution is None or execution["task_id"] != task_id:
        raise HTTPException(status_code=404, detail="execution not found")
    return StreamingResponse(
        event_stream.execution_frames(execution_id, after_seq=after,
                                      include_deltas=deltas),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/{task_id}/executions/{execution_id}/events-page")
def list_execution_events_page(task_id: str, execution_id: str, after: int = 0,
                               limit: int = 1000,
                               conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """One execution's durable events as JSON pages (v1.13).

    The Execution detail document reads its rows here instead of paging the
    whole task log — opening detail on a long task no longer costs O(task).
    The SSE stream (`.../events?after=`) stays the live view; sequence numbers
    are global, so `after` continues across both."""
    _task_or_404(conn, task_id)
    execution = store.get_execution(conn, execution_id)
    if execution is None or execution["task_id"] != task_id:
        raise HTTPException(status_code=404, detail="execution not found")
    events = store.list_events(conn, execution_id, after_seq=after,
                               limit=max(1, min(int(limit), 1000)))
    return {"task_id": task_id, "execution_id": execution_id,
            "events": events,
            "last_seq": events[-1]["seq"] if events else int(after)}


@router.get("/{task_id}/events")
def list_task_events(task_id: str, after: int = 0, limit: int = 500,
                     conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Task-scoped durable event page (poll/refresh source for the command
    center; the per-execution SSE is the live view)."""
    _task_or_404(conn, task_id)
    events = store.list_task_events(conn, task_id, after_seq=after, limit=limit)
    return {"task_id": task_id, "events": events,
            "last_seq": events[-1]["seq"] if events else int(after)}


@router.post("/{task_id}/steer")
def steer_task(task_id: str, body: SteerRequest,
               conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Steer the CURRENT execution — the direction is injected into the running
    model loop, not implemented as cancel-and-rerun. 409 when nothing is
    executing (the client should delegate instead)."""
    _task_or_404(conn, task_id)
    execution = runtime.steer(conn, task_id, body.text)
    if execution is None:
        raise HTTPException(status_code=409, detail="no active execution to steer")
    return {"status": "steering", "execution": execution}


@router.post("/{task_id}/executions/{execution_id}/stop")
def stop_execution(task_id: str, execution_id: str,
                   conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    execution = runtime.stop(conn, execution_id)
    if execution is None or execution["task_id"] != task_id:
        raise HTTPException(status_code=404, detail="execution not found")
    return {"status": "stopping" if execution["status"] in store.EXEC_ACTIVE_STATUSES
            else execution["status"], "execution": execution}


@router.post("/{task_id}/executions/{execution_id}/resume",
             status_code=status.HTTP_201_CREATED)
def resume_execution(task_id: str, execution_id: str,
                     conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Resume an interrupted/failed execution as a new one carrying the same
    Direction (durable recovery affordance after a sidecar restart)."""
    _task_or_404(conn, task_id)
    prior = store.get_execution(conn, execution_id)
    if prior is None or prior["task_id"] != task_id:
        raise HTTPException(status_code=404, detail="execution not found")
    try:
        execution = runtime.resume(conn, execution_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except AgentUnavailable as exc:
        raise HTTPException(status_code=422, detail=redact_text(str(exc)))
    return {"execution": execution, "resumed_from": execution_id}


# --- decisions ------------------------------------------------------------------


@router.get("/{task_id}/decisions")
def list_decisions(task_id: str, status_filter: str | None = None,
                   conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    rows = store.list_decisions(conn, task_id, status=status_filter)
    return {"task_id": task_id,
            "decisions": [_with_impact(conn, task_id, d) for d in rows]}


@router.post("/{task_id}/decisions/{decision_id}/resolve")
def resolve_decision(task_id: str, decision_id: str, body: DecisionResolve,
                     conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Cross (or decline) a confirmation boundary — durably.

    Since v1.11 a Decision is raised by a gated tool inside the running
    execution: approving here wakes that tool (the bounded, audited import runs
    server-side and its result goes back to the model), declining returns a
    structured refusal to the model. ``scope=task`` also allows later calls of
    the same action_type in this task without pausing."""
    _task_or_404(conn, task_id)
    decision = store.get_decision(conn, decision_id)
    if decision is None or decision["task_id"] != task_id:
        raise HTTPException(status_code=404, detail="decision not found")
    resolved = store.resolve_decision(conn, decision_id, body.resolution, body.note,
                                      scope=body.scope)
    if resolved is None:
        raise HTTPException(status_code=409,
                            detail=f"decision is already {decision['status']}")
    audit.record(conn, "task.decision.resolved",
                 {"task_id": task_id, "decision_id": decision_id,
                  "action_type": resolved["action_type"], "resolution": body.resolution,
                  "scope": resolved.get("scope")},
                 run_id=None, session_id=task_id)
    runtime.on_decision_resolved(conn, resolved)
    prepared = None
    conn.commit()
    return {"decision": resolved, "prepared": prepared}


# --- work results / artifacts / context -------------------------------------------


@router.get("/{task_id}/work-results")
def list_work_results(task_id: str, limit: int = 100,
                      conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    return {"task_id": task_id,
            "work_results": store.list_work_results(conn, task_id, limit=limit)}


@router.get("/{task_id}/artifacts")
def list_artifacts(task_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    return {"task_id": task_id, "artifacts": store.list_artifacts(conn, task_id)}


@router.get("/{task_id}/provenance")
def get_task_provenance(task_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Finding/figure evidence chains plus the latest deterministic analysis
    documents those chains cite. Read-only projection of existing rows."""
    _task_or_404(conn, task_id)
    return provenance.project(conn, task_id)


@router.get("/{task_id}/context")
def get_task_context(task_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """The latest TYPED, versioned Storage Task Context. When no version exists
    yet (a task that predates the runtime), a first snapshot is taken now —
    machine state is derived from durable rows, never from replaying chat."""
    _task_or_404(conn, task_id)
    latest = store.latest_context(conn, task_id)
    if latest is None:
        version = task_context.refresh(conn, task_id)
        conn.commit()
        latest = store.latest_context(conn, task_id)
        if latest is None:  # pragma: no cover — refresh always writes v1
            raise HTTPException(status_code=500, detail=f"context snapshot failed (v{version})")
    return latest


class RevisitScheduleIn(BaseModel):
    interval_days: int = Field(ge=1, le=365)
    enabled: bool = True


@router.get("/{task_id}/remediation-plans")
def list_remediation_plans(task_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    from ..analysis import remediation as plan_mod
    return {"task_id": task_id, "plans": plan_mod.list_plans(conn, task_id)}


@router.get("/{task_id}/baselines")
def list_baselines(task_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    from ..analysis import baseline as baseline_mod
    return {"task_id": task_id, "baselines": baseline_mod.list_baselines(conn, task_id)}


@router.get("/{task_id}/revisit")
def get_revisit(task_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    from ..task_runtime import revisit as revisit_mod
    return {"task_id": task_id, "schedule": revisit_mod.get_schedule(conn, task_id)}


@router.put("/{task_id}/revisit")
def put_revisit(task_id: str, body: RevisitScheduleIn,
                conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    from ..task_runtime import revisit as revisit_mod
    row = revisit_mod.set_schedule(
        conn, task_id, interval_days=body.interval_days, enabled=body.enabled)
    return {"task_id": task_id, "schedule": row}


@router.post("/{task_id}/compact")
def compact_context(task_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """v1.12 — run the compaction step on demand (palette: Compact context).
    Only for a task with no live execution; the same step the runtime runs
    automatically when the window fills. Appends ``context.compacted`` to the
    task's event log (no execution) and returns the figures for the meter."""
    _task_or_404(conn, task_id)
    if store.active_execution(conn, task_id) is not None:
        raise HTTPException(status_code=409, detail="an execution is active on this task")
    from ..agent_runtime import compaction
    from ..agent_runtime.agent_service import get_model_credentials
    try:
        creds = get_model_credentials(conn)
    except AgentUnavailable as exc:
        raise HTTPException(status_code=422, detail=redact_text(str(exc)))
    out = compaction.compact(conn, task_id, creds, None)
    if not out:
        return {"compacted": False, "reason": "nothing to compact or no usable summary"}
    payload = {k: out.get(k) for k in ("before_tokens", "after_tokens", "summary_chars")}
    store.append_event(conn, "", task_id, "context.compacted", payload)
    conn.commit()
    return {"compacted": True, **payload}


@router.post("/{task_id}/verify", status_code=status.HTTP_201_CREATED)
def verify_plan(task_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    """Submit a Verify Execution through the ONE runtime submit path."""
    _task_or_404(conn, task_id)
    from ..analysis import remediation as plan_mod
    from ..task_runtime import revisit as revisit_mod
    if plan_mod.latest(conn, task_id) is None:
        raise HTTPException(status_code=404, detail="no remediation plan on this task")
    direction = (
        "[verify] Re-probe the configuration items in the current remediation "
        "plan with read-only tools. Diff each recommended action against live "
        "state via verify_remediation_plan. Record applied / not_applied / "
        "partial / cannot_verify. Do not mutate storage and do not resolve "
        "Decisions yourself."
    )
    try:
        execution = runtime.submit(conn, task_id, direction, kind=revisit_mod.VERIFY_KIND)
    except AgentUnavailable as exc:
        raise HTTPException(status_code=422, detail=redact_text(str(exc)))
    return {"execution": execution, "created": True}
