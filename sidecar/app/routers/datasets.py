"""Dataset endpoints (Phase 05): upload + list + get.

Uploaded files are copied into the per-run raw directory
(``data/runs/{run_id}/raw/``). Only the stored RELATIVE path is recorded.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)

from .. import audit, config
from ..db import get_conn
from ..models.schemas import DatasetOut, DatasetUploadResponse
from ..repositories import datasets as repo
from ..repositories import runs as runs_repo

router = APIRouter(tags=["datasets"])

_VALID_TYPES = {"access_log", "inventory"}


def _safe_filename(name: str) -> str:
    # Strip any directory components; keep a simple basename.
    base = Path(name or "upload.dat").name
    return base or "upload.dat"


@router.post("/runs/{run_id}/datasets/upload", response_model=DatasetUploadResponse)
async def upload_dataset(
    run_id: str,
    file: UploadFile = File(...),
    dataset_type: str = Form(...),
    name: str | None = Form(None),
    conn: sqlite3.Connection = Depends(get_conn),
) -> Any:
    if runs_repo.get_row(conn, run_id) is None:
        raise HTTPException(status_code=404, detail="run not found")
    if dataset_type not in _VALID_TYPES:
        raise HTTPException(status_code=422, detail="dataset_type must be 'access_log' or 'inventory'")

    filename = _safe_filename(file.filename or "upload.dat")
    raw_dir = config.run_dir(run_id) / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    dest = raw_dir / filename

    contents = await file.read()
    dest.write_bytes(contents)

    stored_rel = config.rel_path(dest)
    dataset_id = repo.create(conn, run_id, dataset_type, name, filename, stored_rel)
    audit.record(
        conn,
        "dataset.upload",
        {"dataset_id": dataset_id, "dataset_type": dataset_type, "stored_path": stored_rel,
         "bytes": len(contents)},
        run_id=run_id,
    )
    conn.commit()

    return DatasetUploadResponse(
        dataset_id=dataset_id,
        run_id=run_id,
        dataset_type=dataset_type,
        filename=filename,
        status="uploaded",
        row_count=None,
    )


@router.get("/datasets", response_model=list[DatasetOut])
def list_datasets(conn: sqlite3.Connection = Depends(get_conn)):
    return repo.list_all(conn)


@router.get("/datasets/{dataset_id}", response_model=DatasetOut)
def get_dataset(dataset_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    ds = repo.get(conn, dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return ds
