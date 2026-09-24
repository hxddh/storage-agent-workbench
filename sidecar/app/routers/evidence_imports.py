"""Managed evidence imports — read-only compatibility API.

Data movement (plan → confirm → run in ``app.evidence.import_service``) is
reachable ONLY through the Agent's gated ``import_evidence`` tool, which opens
a durable Decision (``runtime.request_approval``) inside the running Execution
and consults the approval policy. This router exposes no route that plans,
confirms or runs an import; it only reads the recorded rows.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..db import get_conn
from ..models.schemas import EvidenceImportOut
from ..repositories import evidence_imports as repo

router = APIRouter(prefix="/evidence-imports", tags=["evidence-imports"])


@router.get("/{import_id}", response_model=EvidenceImportOut)
def get_import(import_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    data = repo.get(conn, import_id)
    if data is None:
        raise HTTPException(status_code=404, detail="evidence import not found")
    return EvidenceImportOut(**data)


@router.get("/{import_id}/files")
def list_import_files(import_id: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict[str, Any]:
    data = repo.get(conn, import_id)
    if data is None:
        raise HTTPException(status_code=404, detail="evidence import not found")
    return {"import_id": import_id, "files": data["files"]}
