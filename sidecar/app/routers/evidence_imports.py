"""Managed evidence-import endpoints.

Flow: plan -> (explicit) confirm -> run. Nothing is downloaded until a plan is
explicitly confirmed; confirmation is recorded in approval_events + audit_logs.
Import targets are validated against the evidence sources DISCOVERED by
account_discovery — the caller cannot point this at an arbitrary
bucket/key. On run, only the confirmed evidence files are downloaded (bounded by
max_files / max_bytes) and fed into the existing inventory_analysis /
access_log_analysis path.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from .. import audit, config, run_service
from ..db import get_conn
from ..evidence import managed_import as mi
from ..models.schemas import (
    EvidenceImportOut,
    EvidenceImportPlanRequest,
    EvidenceImportRunResult,
    RunCreate,
)
from ..repositories import account_discovery as account_repo
from ..repositories import datasets as datasets_repo
from ..repositories import evidence_imports as repo
from ..repositories import runs as runs_repo
from ..security.redaction import redact_text

router = APIRouter(prefix="/evidence-imports", tags=["evidence-imports"])


# The import API uses "access_log"; the discovered evidence source
# is named "server_access_logging".
_SOURCE_TYPE_ALIAS = {"access_log": "server_access_logging", "inventory": "inventory"}


def _find_evidence_source(profile: dict[str, Any], bucket_name: str, source_type: str) -> dict[str, Any] | None:
    target = _SOURCE_TYPE_ALIAS.get(source_type, source_type)
    for b in profile.get("buckets", []) or []:
        if b.get("bucket_name") != bucket_name:
            continue
        for s in b.get("evidence_sources", []) or []:
            if s.get("source_type") == target and s.get("status") == "available":
                return s.get("detail") or {}
    return None


@router.post("/plan", response_model=EvidenceImportOut, status_code=status.HTTP_201_CREATED)
def plan_import(body: EvidenceImportPlanRequest, conn: sqlite3.Connection = Depends(get_conn)):
    profile = account_repo.get_profile(conn, body.account_run_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="no account profile for that account_run_id")

    detail = _find_evidence_source(profile, body.bucket_name, body.source_type)
    if detail is None:
        raise HTTPException(
            status_code=422,
            detail=f"no discovered '{body.source_type}' evidence source (status=available) "
                   f"for bucket '{body.bucket_name}' in that account discovery run",
        )

    provider_id = profile.get("provider_id")
    snapshot_id = None  # profile is keyed by run; snapshot linkage is implicit
    max_files, max_bytes = mi.clamp_bounds(body.max_files, body.max_bytes)

    if body.source_type == "inventory":
        configs = detail.get("configurations") or []
        if not configs:
            raise HTTPException(status_code=422, detail="inventory evidence source has no configuration")
        cfg = configs[0]
        dest_bucket = cfg.get("destination_bucket")
        dest_prefix = cfg.get("destination_prefix") or ""
        if not dest_bucket:
            raise HTTPException(status_code=422, detail="inventory destination bucket is unknown")
        plan = mi.plan_inventory(
            conn, provider_id, dest_bucket, dest_prefix,
            evidence_ref=cfg.get("inventory_id"), declared_format=cfg.get("format"),
            max_files=max_files, max_bytes=max_bytes,
        )
    else:  # access_log
        if not body.time_range_start or not body.time_range_end:
            raise HTTPException(status_code=422, detail="access_log import requires time_range_start and time_range_end")
        target_bucket = detail.get("target_bucket")
        target_prefix = detail.get("target_prefix") or ""
        if not target_bucket:
            raise HTTPException(status_code=422, detail="logging target bucket is unknown")
        plan = mi.plan_access_log(
            conn, provider_id, target_bucket, target_prefix,
            evidence_ref="server_access_logging",
            time_range_start=body.time_range_start, time_range_end=body.time_range_end,
            max_files=max_files, max_bytes=max_bytes,
        )

    import_id = repo.create_plan(
        conn, provider_id=provider_id, account_run_id=body.account_run_id, snapshot_id=snapshot_id,
        source_type=plan.source_type, source_bucket=plan.source_bucket, source_prefix=plan.source_prefix,
        evidence_ref=plan.evidence_ref, fmt=plan.fmt, fmt_schema=plan.schema, plan_source=plan.plan_source,
        max_files=plan.max_files, max_bytes=plan.max_bytes,
        time_range_start=plan.time_range_start, time_range_end=plan.time_range_end,
        planned_file_count=plan.planned_file_count, planned_total_bytes=plan.planned_total_bytes,
        selected_file_count=len(plan.selected), selected_total_bytes=plan.selected_total_bytes,
        warnings=plan.warnings, files=plan.selected,
    )
    audit.record(conn, "evidence_import.plan",
                 {"import_id": import_id, "source_type": plan.source_type,
                  "plan_source": plan.plan_source, "selected_files": len(plan.selected),
                  "selected_bytes": plan.selected_total_bytes}, run_id=None)
    conn.commit()
    return EvidenceImportOut(**repo.get(conn, import_id))


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
    data = repo.get(conn, import_id)
    if data is None:
        raise HTTPException(status_code=404, detail="evidence import not found")
    if data["status"] != "planned":
        raise HTTPException(status_code=409, detail=f"import is '{data['status']}', not 'planned'")
    if data["selected_file_count"] <= 0:
        raise HTTPException(status_code=422, detail="nothing to import: the plan selected zero files")
    if data["selected_file_count"] > mi.HARD_MAX_FILES or data["selected_total_bytes"] > mi.HARD_MAX_BYTES:
        raise HTTPException(status_code=422, detail="selection exceeds hard limits; lower max_files / max_bytes")

    repo.set_status(conn, import_id, "confirmed")
    # Record the explicit approval (approval_events + audit_logs).
    conn.execute(
        "INSERT INTO approval_events (id, run_id, action, decision, detail_json_sanitized, created_at) "
        "VALUES (?, NULL, 'evidence_import.download', 'approved', ?, datetime('now'))",
        (uuid.uuid4().hex,
         f'{{"import_id":"{import_id}","selected_files":{data["selected_file_count"]},'
         f'"selected_bytes":{data["selected_total_bytes"]}}}'),
    )
    audit.record(conn, "evidence_import.confirm",
                 {"import_id": import_id, "selected_files": data["selected_file_count"],
                  "selected_bytes": data["selected_total_bytes"]}, run_id=None)
    conn.commit()
    return EvidenceImportOut(**repo.get(conn, import_id))


@router.post("/{import_id}/run", response_model=EvidenceImportRunResult)
def run_import(import_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    data = repo.get(conn, import_id)
    if data is None:
        raise HTTPException(status_code=404, detail="evidence import not found")
    if data["status"] != "confirmed":
        raise HTTPException(status_code=409, detail=f"import must be confirmed before running (is '{data['status']}')")

    source_type = data["source_type"]
    dataset_type = "inventory" if source_type == "inventory" else "access_log"
    run_type = "inventory_analysis" if source_type == "inventory" else "access_log_analysis"

    # Create the analysis run that will own the downloaded dataset.
    label = f"managed-evidence:{data['source_bucket']}/{data['source_prefix'] or ''}"
    analysis_run_id = runs_repo.create(
        conn,
        RunCreate(
            run_type=run_type, provider_id=data["provider_id"],
            title=f"Managed {dataset_type} import",
            user_prompt="Analyze evidence imported from a discovered evidence source.",
        ),
        status="pending",
    )
    from ..events import bus
    bus.create(analysis_run_id)
    repo.set_status(conn, import_id, "importing", analysis_run_id=analysis_run_id)

    selected = repo.selected_files(conn, import_id)
    files = [{"object_key": f["object_key"], "size": f["size_bytes"]} for f in selected]
    dest_dir = config.run_dir(analysis_run_id) / "raw"

    try:
        combined, total = mi.download_and_combine(
            conn, data["provider_id"], source_type, data["source_bucket"],
            data.get("format"), data.get("fmt_schema"),
            files, data["max_files"], data["max_bytes"], dest_dir,
        )
    except (mi.ImportError_, Exception) as exc:  # noqa: BLE001 - sanitized
        repo.set_status(conn, import_id, "failed")
        repo.mark_files(conn, import_id, "failed")
        audit.record(conn, "evidence_import.failed",
                     {"import_id": import_id, "error": redact_text(str(exc))}, run_id=None)
        conn.commit()
        raise HTTPException(status_code=400, detail=f"evidence download failed: {redact_text(str(exc))}")

    stored_rel = config.rel_path(combined)
    datasets_repo.create(
        conn, analysis_run_id, dataset_type,
        name="managed_evidence_import", source_filename=redact_text(label),
        stored_path_rel=stored_rel,
    )
    repo.mark_files(conn, import_id, "downloaded")
    repo.set_status(conn, import_id, "imported")
    audit.record(conn, "evidence_import.download",
                 {"import_id": import_id, "downloaded_files": len(files),
                  "downloaded_bytes": total, "stored_path": stored_rel,
                  "analysis_run_id": analysis_run_id}, run_id=analysis_run_id)
    conn.commit()

    # Hand off to the existing deterministic analysis executor.
    run_service.start(analysis_run_id)

    return EvidenceImportRunResult(
        import_id=import_id, status="imported", analysis_run_id=analysis_run_id,
        downloaded_file_count=len(files), downloaded_total_bytes=total,
    )
