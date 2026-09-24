"""Dataset endpoints: list + get (read-only).

Run datasets are written server-side (evidence import's analysis hand-off);
user files attach to a Task through ``POST /sessions/{id}/datasets/upload``,
which shares the streaming bounds below. There is no per-run upload route:
runs are not created or fed over HTTP.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from ..db import get_conn
from ..models.schemas import DatasetOut
from ..repositories import datasets as repo

router = APIRouter(tags=["datasets"])

# The session upload (routers/sessions.py) streams to disk in this chunk size,
# capped at this total. Bounds the memory footprint (never a full read into
# RAM) and refuses a runaway upload.
_UPLOAD_CHUNK = 1024 * 1024  # 1 MiB
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB


@router.get("/datasets", response_model=list[DatasetOut])
def list_datasets(conn: sqlite3.Connection = Depends(get_conn)):
    return repo.list_all(conn)


@router.get("/datasets/{dataset_id}", response_model=DatasetOut)
def get_dataset(dataset_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    ds = repo.get(conn, dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return ds
