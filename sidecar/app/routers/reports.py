"""Report retrieval."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from .. import config
from ..db import get_conn
from ..models.schemas import ReportOut

router = APIRouter(tags=["reports"])


def _resolve_report_path(stored: str) -> Path:
    """Resolve a stored report path against the app data dir.

    Rows are now written RELATIVE to the data dir (no absolute paths that may
    embed a username). Legacy rows hold an absolute path — accept those as-is.
    """
    p = Path(stored)
    return p if p.is_absolute() else config.data_dir() / p


@router.get("/reports/{run_id}", response_model=ReportOut)
def get_report(run_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    row = conn.execute(
        "SELECT * FROM reports WHERE run_id = ? ORDER BY created_at DESC, id LIMIT 1",
        (run_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="report not found for run")

    path = _resolve_report_path(row["report_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="report file missing")

    return ReportOut(
        run_id=run_id,
        report_path=row["report_path"],
        format=row["format"],
        created_at=row["created_at"],
        content=path.read_text(encoding="utf-8"),
    )
