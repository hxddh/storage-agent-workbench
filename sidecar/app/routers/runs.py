"""Deterministic run records — read-only compatibility API (+ delete).

Runs are PURE deterministic compute — there is no LLM planner. All five run
types (diagnostic, access_log_analysis, inventory_analysis, bucket_config_review,
account_discovery) execute via their deterministic executors, reached ONLY
through the Agent runtime (``run_service``) or evidence import's server-side
analysis hand-off. There is no HTTP route that creates or starts a run and no
run event stream: the durable Agent Task runtime is the one submit path, and a
run's progress is its persisted ``runs`` / ``tool_calls`` / report rows.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, status

from .. import audit, config
from ..db import get_conn
from ..models.schemas import AccountProfileOut, RunDetail, RunSummary
from ..repositories import account_discovery as account_repo
from ..repositories import runs as repo

router = APIRouter(prefix="/runs", tags=["runs"])


@router.get("", response_model=list[RunSummary])
def list_runs(conn: sqlite3.Connection = Depends(get_conn)):
    return repo.list_all(conn)


@router.get("/{run_id}", response_model=RunDetail)
def get_run(run_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    detail = repo.get_detail(conn, run_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="run not found")
    return detail


@router.delete("/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_run(run_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    """Delete a run: its row (child messages/tool_calls/reports/snapshots and
    session links cascade) and its on-disk ``data/runs/{run_id}/`` tree (raw
    evidence, analysis.duckdb, report.md). Without this the deterministic layer
    had no delete surface at all, so runs — including the ones the agent mints on
    every survey/review — accumulated on disk forever."""
    import shutil

    row = repo.get_row(conn, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    if row["status"] == "running":
        # A running run has a live executor thread on its own connection:
        # deleting the row under it makes its child-row inserts fail, and its
        # report/analysis writes RECREATE data/runs/{run_id}/ after the rmtree —
        # permanently orphaned files, the exact leak this endpoint exists to
        # prevent. Refuse; the caller can delete once it reaches a terminal state.
        raise HTTPException(status_code=409,
                            detail="run is currently executing; wait for it to "
                                   "finish (or fail) before deleting it")
    repo.delete(conn, run_id)
    shutil.rmtree(config.run_dir(run_id), ignore_errors=True)
    # The run row is already gone, so its session link is unrecoverable here;
    # the event stays run-scoped in the global trail.
    audit.record(conn, "run.delete", {"run_id": run_id}, run_id=None)
    conn.commit()
    return None


@router.get("/{run_id}/account-profile", response_model=AccountProfileOut)
def get_account_profile(run_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    """Structured account-discovery result (bucket table + evidence sources)."""
    profile = account_repo.get_profile(conn, run_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="no account profile for this run")
    return AccountProfileOut(**profile)
