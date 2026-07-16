"""Dataset endpoints: upload + list + get.

Uploaded files are copied into the per-run raw directory
(``data/runs/{run_id}/raw/``). Only the stored RELATIVE path is recorded.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
)

from .. import audit, config
from ..db import get_conn
from ..models.schemas import DatasetOut, DatasetUploadResponse
from ..repositories import datasets as repo
from ..repositories import runs as runs_repo

router = APIRouter(tags=["datasets"])

_VALID_TYPES = {"access_log", "inventory"}
# Upload streams to disk in this chunk size, capped at this total. Bounds the
# memory footprint (never a full read into RAM) and refuses a runaway upload.
_UPLOAD_CHUNK = 1024 * 1024  # 1 MiB
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB


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

    # Stream to disk in bounded chunks (never a single in-memory read) and cap
    # the total so a huge/runaway upload can't exhaust memory or disk.
    # Temp-then-rename: write to a .part file and os.replace() only on success —
    # a mid-stream failure (client disconnect) must never leave a TRUNCATED file
    # at the final path (a same-named re-upload previously destroyed the file an
    # existing dataset row still referenced, silently analyzed later).
    total = 0
    tmp = dest.with_name(dest.name + f".part-{uuid4().hex[:8]}")
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
    dataset_id = repo.create(conn, run_id, dataset_type, name, filename, stored_rel)
    audit.record(
        conn,
        "dataset.upload",
        {"dataset_id": dataset_id, "dataset_type": dataset_type, "stored_path": stored_rel,
         "bytes": total},
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
