"""Managed evidence-import endpoints (compatibility API over ``import_service``).

Flow: plan -> (explicit) confirm -> run. See ``app.evidence.import_service`` —
the same bounded path the Agent's gated ``import_evidence`` tool uses.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from ..db import get_conn
from ..evidence import import_service
from ..models.schemas import (
    EvidenceImportOut,
    EvidenceImportPlanRequest,
    EvidenceImportRunResult,
)
from ..repositories import evidence_imports as repo

router = APIRouter(prefix="/evidence-imports", tags=["evidence-imports"])


def _raise(exc: import_service.ImportServiceError) -> None:
    raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.post("/plan", response_model=EvidenceImportOut, status_code=status.HTTP_201_CREATED)
def plan_import(body: EvidenceImportPlanRequest, conn: sqlite3.Connection = Depends(get_conn)):
    try:
        data = import_service.plan(
            conn, account_run_id=body.account_run_id, bucket_name=body.bucket_name,
            source_type=body.source_type, max_files=body.max_files, max_bytes=body.max_bytes,
            time_range_start=body.time_range_start, time_range_end=body.time_range_end)
    except import_service.ImportServiceError as exc:
        _raise(exc)
    return EvidenceImportOut(**data)


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


@router.post("/{import_id}/confirm", response_model=EvidenceImportOut)
def confirm_import(import_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    try:
        data = import_service.confirm(conn, import_id)
    except import_service.ImportServiceError as exc:
        _raise(exc)
    return EvidenceImportOut(**data)


@router.post("/{import_id}/run", response_model=EvidenceImportRunResult)
def run_import(import_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    try:
        out = import_service.run(conn, import_id)
    except import_service.ImportServiceError as exc:
        _raise(exc)
    return EvidenceImportRunResult(**out)
