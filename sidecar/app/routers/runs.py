"""Analysis Run endpoints.

Runs are PURE deterministic compute — there is no LLM planner. All five run
types (diagnostic, access_log_analysis, inventory_analysis, bucket_config_review,
account_discovery) execute via their deterministic executors. The conversational
agent invokes these engines as tools or proposes a saved report; it never plans
or narrates inside a run.

`POST /runs` (`create_run`) is an INTERNAL / testing entry point for the
deterministic run layer — it is NOT a user-facing surface (the frontend never
calls it; the agent uses `run_service` directly, and evidence import creates its
run server-side). It stays because the deterministic layer is the reproducibility
/ security floor and the test suite creates runs through it. Do not wire it into
the UI as a "new run" form — that runs-first flow was removed.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse

from .. import run_service
from ..db import get_conn
from ..events import bus, sse_stream
from ..models.schemas import (
    AccountProfileOut,
    MessageCreate,
    RunCreate,
    RunCreated,
    RunDetail,
    RunSummary,
)
from ..repositories import account_discovery as account_repo
from ..repositories import runs as repo
from ..repositories import sessions as sessions_repo

router = APIRouter(prefix="/runs", tags=["runs"])


@router.get("", response_model=list[RunSummary])
def list_runs(conn: sqlite3.Connection = Depends(get_conn)):
    return repo.list_all(conn)


# Run types that actually execute (vs. placeholders).
_EXECUTABLE = {
    "diagnostic", "access_log_analysis", "inventory_analysis",
    "bucket_config_review", "account_discovery",
}
# Run types that need a provider + bucket (vs. file-upload analysis runs).
_NEEDS_BUCKET = {"diagnostic", "bucket_config_review"}
# Run types that need a provider but operate at the account level (no bucket).
_NEEDS_PROVIDER_ONLY = {"account_discovery"}
@router.post("", response_model=RunCreated, status_code=status.HTTP_201_CREATED)
def create_run(body: RunCreate, conn: sqlite3.Connection = Depends(get_conn)):
    if body.run_type in _NEEDS_BUCKET:
        missing = [
            field
            for field in ("provider_id", "bucket", "user_prompt")
            if not getattr(body, field)
        ]
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"{body.run_type} run requires: {', '.join(missing)}",
            )
        run_id = repo.create(conn, body, status="pending")
        bus.create(run_id)
    elif body.run_type in _NEEDS_PROVIDER_ONLY:
        # account_discovery enumerates the whole account; it needs a provider but
        # no bucket. user_prompt is optional (a default is supplied).
        if not body.provider_id:
            raise HTTPException(
                status_code=422,
                detail=f"{body.run_type} run requires: provider_id",
            )
        if not body.user_prompt:
            body = body.model_copy(update={"user_prompt": "Discover account-level buckets and evidence sources."})
        run_id = repo.create(conn, body, status="pending")
        bus.create(run_id)
    elif body.run_type in _EXECUTABLE:
        # Analysis runs need a user_prompt; the dataset is uploaded separately.
        if not body.user_prompt:
            raise HTTPException(
                status_code=422,
                detail=f"{body.run_type} run requires: user_prompt",
            )
        run_id = repo.create(conn, body, status="pending")
        bus.create(run_id)
    else:
        # Unreachable: run_type is a RunType Literal (FastAPI 422s anything else
        # before this handler), and _EXECUTABLE covers every RunType value. Kept
        # as a defensive guard rather than a silent fall-through.
        raise HTTPException(status_code=422, detail=f"run_type '{body.run_type}' is not executable")

    # Link the run to its session immediately so it appears in the timeline.
    if body.session_id and sessions_repo.get_row(conn, body.session_id) is not None:
        sessions_repo.link_run(conn, body.session_id, run_id, sessions_repo.RUN_ROLE.get(body.run_type))

    row = repo.get_row(conn, run_id)
    return RunCreated(
        run_id=run_id,
        status=row["status"],
        title=row["title"],
        created_at=row["created_at"],
    )


@router.get("/{run_id}", response_model=RunDetail)
def get_run(run_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    detail = repo.get_detail(conn, run_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="run not found")
    return detail


@router.get("/{run_id}/account-profile", response_model=AccountProfileOut)
def get_account_profile(run_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    """Structured account-discovery result (bucket table + evidence sources)."""
    profile = account_repo.get_profile(conn, run_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="no account profile for this run")
    return AccountProfileOut(**profile)


@router.post("/{run_id}/message")
def post_message(
    run_id: str, body: MessageCreate, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    row = repo.get_row(conn, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    if row["run_type"] not in _EXECUTABLE:
        raise HTTPException(
            status_code=409,
            detail=f"run_type '{row['run_type']}' has no executable message turn",
        )
    # Refuse to spawn a second executor over a run that is already in flight or
    # finished. This must be an ATOMIC claim, not check-then-act: two concurrent
    # POSTs (double-click / client retry) on separate threadpool threads both
    # read 'pending' and both spawned executors racing on the same run row —
    # duplicate tool_calls, both writing report.md, terminal-status flapping.
    # A single conditional UPDATE lets exactly one caller through.
    claimed = conn.execute(
        "UPDATE runs SET status = 'running' WHERE id = ? "
        "AND status NOT IN ('running', 'completed')",
        (run_id,),
    ).rowcount
    conn.commit()
    if not claimed:
        raise HTTPException(
            status_code=409,
            detail="run is already running or completed; cannot start another executor for it",
        )

    repo.add_message(conn, run_id, role="user", content=body.content)
    bus.create(run_id)
    run_service.start(run_id)
    return {"run_id": run_id, "status": "running"}


@router.get("/{run_id}/events")
def run_events(run_id: str) -> StreamingResponse:
    return StreamingResponse(
        sse_stream(run_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
