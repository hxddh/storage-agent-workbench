"""Managed evidence import — the ONE data-moving path (plan → confirm → run).

Used by two callers with the same bounds and the same audit trail:

- the ``/evidence-imports`` compatibility API;
- the Agent's gated ``import_evidence`` tool, which plans here, then PAUSES the
  execution for the user's approval, and only runs after it was granted.

Nothing is downloaded until a plan is explicitly confirmed; confirmation is
recorded in approval_events + audit_logs. Import targets are validated against
the evidence sources DISCOVERED by account_discovery — a caller cannot point
this at an arbitrary bucket/key. On run, only the confirmed files are
downloaded (bounded by max_files / max_bytes) and fed into the existing
inventory_analysis / access_log_analysis path.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
from typing import Any

from .. import audit, config, run_service
from ..models.schemas import RunCreate
from ..repositories import account_discovery as account_repo
from ..repositories import datasets as datasets_repo
from ..repositories import evidence_imports as repo
from ..repositories import runs as runs_repo
from ..s3 import client_factory
from ..security.redaction import redact_text
from . import managed_import as mi


class ImportServiceError(Exception):
    """A user-facing, already-sanitized failure with an HTTP-shaped status."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def safe_err(exc: object) -> str:
    """Redact secrets AND collapse absolute filesystem paths from an error
    surfaced to a user (an OSError/download failure can carry the app's
    absolute paths, which `redact_text` alone leaves in)."""
    return config.scrub_paths(redact_text(str(exc)))


# The import API uses "access_log"; the discovered evidence source
# is named "server_access_logging".
_SOURCE_TYPE_ALIAS = {"access_log": "server_access_logging", "inventory": "inventory"}


def find_evidence_source(profile: dict[str, Any], bucket_name: str,
                         source_type: str) -> dict[str, Any] | None:
    target = _SOURCE_TYPE_ALIAS.get(source_type, source_type)
    for b in profile.get("buckets", []) or []:
        if b.get("bucket_name") != bucket_name:
            continue
        for s in b.get("evidence_sources", []) or []:
            if s.get("source_type") == target and s.get("status") == "available":
                return s.get("detail") or {}
    return None


def plan(conn: sqlite3.Connection, *, account_run_id: str, bucket_name: str,
         source_type: str, max_files: int | None = None, max_bytes: int | None = None,
         time_range_start: str | None = None,
         time_range_end: str | None = None) -> dict[str, Any]:
    """Plan a bounded import against a DISCOVERED evidence source. Lists the
    source prefix (read-only), selects files within bounds, persists the plan
    as ``planned``. Returns the import row. Raises ImportServiceError."""
    profile = account_repo.get_profile(conn, account_run_id)
    if profile is None:
        raise ImportServiceError(404, "no account profile for that account_run_id")
    detail = find_evidence_source(profile, bucket_name, source_type)
    if detail is None:
        raise ImportServiceError(
            422, f"no discovered '{source_type}' evidence source (status=available) "
                 f"for bucket '{bucket_name}' in that account discovery run")
    provider_id = profile.get("provider_id")
    max_files, max_bytes = mi.clamp_bounds(max_files, max_bytes)
    try:
        if source_type == "inventory":
            configs = detail.get("configurations") or []
            if not configs:
                raise ImportServiceError(422, "inventory evidence source has no configuration")
            cfg = configs[0]
            dest_bucket = cfg.get("destination_bucket")
            dest_prefix = cfg.get("destination_prefix") or ""
            if not dest_bucket:
                raise ImportServiceError(422, "inventory destination bucket is unknown")
            planned = mi.plan_inventory(
                conn, provider_id, dest_bucket, dest_prefix,
                evidence_ref=cfg.get("inventory_id"), declared_format=cfg.get("format"),
                max_files=max_files, max_bytes=max_bytes)
        else:  # access_log
            if not time_range_start or not time_range_end:
                raise ImportServiceError(
                    422, "access_log import requires time_range_start and time_range_end")
            target_bucket = detail.get("target_bucket")
            target_prefix = detail.get("target_prefix") or ""
            if not target_bucket:
                raise ImportServiceError(422, "logging target bucket is unknown")
            planned = mi.plan_access_log(
                conn, provider_id, target_bucket, target_prefix,
                evidence_ref="server_access_logging",
                time_range_start=time_range_start, time_range_end=time_range_end,
                max_files=max_files, max_bytes=max_bytes)
    except ImportServiceError:
        raise
    except client_factory.CredentialResolutionError as exc:
        raise ImportServiceError(424, safe_err(exc)) from exc
    except client_factory.ProviderNotFound as exc:
        raise ImportServiceError(404, "cloud provider not found") from exc
    except Exception as exc:  # noqa: BLE001 — S3/listing errors → sanitized, never raw
        raise ImportServiceError(502, safe_err(f"planning failed: {exc}")) from exc

    import_id = repo.create_plan(
        conn, provider_id=provider_id, account_run_id=account_run_id, snapshot_id=None,
        source_type=planned.source_type, source_bucket=planned.source_bucket,
        source_prefix=planned.source_prefix, evidence_ref=planned.evidence_ref,
        fmt=planned.fmt, fmt_schema=planned.schema, plan_source=planned.plan_source,
        max_files=planned.max_files, max_bytes=planned.max_bytes,
        time_range_start=planned.time_range_start, time_range_end=planned.time_range_end,
        planned_file_count=planned.planned_file_count,
        planned_total_bytes=planned.planned_total_bytes,
        selected_file_count=len(planned.selected),
        selected_total_bytes=planned.selected_total_bytes,
        warnings=planned.warnings, files=planned.selected,
    )
    audit.record(conn, "evidence_import.plan",
                 {"import_id": import_id, "source_type": planned.source_type,
                  "plan_source": planned.plan_source, "selected_files": len(planned.selected),
                  "selected_bytes": planned.selected_total_bytes}, run_id=None)
    conn.commit()
    return repo.get(conn, import_id)  # type: ignore[return-value]


def confirm(conn: sqlite3.Connection, import_id: str,
            approved_by: str = "user") -> dict[str, Any]:
    """Record the explicit approval (approval_events + audit_logs) and move the
    plan to ``confirmed``. Raises ImportServiceError."""
    data = repo.get(conn, import_id)
    if data is None:
        raise ImportServiceError(404, "evidence import not found")
    if data["status"] != "planned":
        raise ImportServiceError(409, f"import is '{data['status']}', not 'planned'")
    if data["selected_file_count"] <= 0:
        raise ImportServiceError(422, "nothing to import: the plan selected zero files")
    if data["selected_file_count"] > mi.HARD_MAX_FILES or data["selected_total_bytes"] > mi.HARD_MAX_BYTES:
        raise ImportServiceError(422, "selection exceeds hard limits; lower max_files / max_bytes")
    repo.set_status(conn, import_id, "confirmed")
    approval_detail = json.dumps({
        "import_id": import_id,
        "selected_files": data["selected_file_count"],
        "selected_bytes": data["selected_total_bytes"],
        "approved_by": approved_by,
    })
    conn.execute(
        "INSERT INTO approval_events (id, run_id, action, decision, detail_json_sanitized, created_at) "
        "VALUES (?, NULL, 'evidence_import.download', 'approved', ?, datetime('now'))",
        (uuid.uuid4().hex, approval_detail),
    )
    audit.record(conn, "evidence_import.confirm",
                 {"import_id": import_id, "selected_files": data["selected_file_count"],
                  "selected_bytes": data["selected_total_bytes"]}, run_id=None)
    conn.commit()
    return repo.get(conn, import_id)  # type: ignore[return-value]


def run(conn: sqlite3.Connection, import_id: str, task_id: str | None = None) -> dict[str, Any]:
    """Download the confirmed files (bounded), persist the dataset, index the
    Artifact, and hand off to the deterministic analysis. Raises
    ImportServiceError; the import row is left ``failed`` on any error."""
    data = repo.get(conn, import_id)
    if data is None:
        raise ImportServiceError(404, "evidence import not found")
    if data["status"] != "confirmed":
        raise ImportServiceError(
            409, f"import must be confirmed before running (is '{data['status']}')")

    source_type = data["source_type"]
    dataset_type = "inventory" if source_type == "inventory" else "access_log"
    run_type = "inventory_analysis" if source_type == "inventory" else "access_log_analysis"

    label = f"managed-evidence:{data['source_bucket']}/{data['source_prefix'] or ''}"
    analysis_run_id = runs_repo.create(
        conn,
        RunCreate(run_type=run_type, provider_id=data["provider_id"],
                  title=f"Managed {dataset_type} import",
                  user_prompt="Analyze evidence imported from a discovered evidence source."),
        status="pending",
    )
    # Atomically claim the confirmed→importing transition: exactly one runner wins.
    if not repo.claim_for_import(conn, import_id, analysis_run_id):
        runs_repo.set_status(conn, analysis_run_id, "failed",
                             final_summary="Superseded by a concurrent import of the same evidence.")
        conn.commit()
        current = repo.get(conn, import_id)
        raise ImportServiceError(
            409, f"import is already being processed (is '{current['status'] if current else 'unknown'}')")
    from ..events import bus
    bus.create(analysis_run_id)

    selected = repo.selected_files(conn, import_id)
    files = [{"object_key": f["object_key"], "size": f["size_bytes"]} for f in selected]
    dest_dir = config.run_dir(analysis_run_id) / "raw"

    try:
        combined, total = mi.download_and_combine(
            conn, data["provider_id"], source_type, data["source_bucket"],
            data.get("format"), data.get("fmt_schema"),
            files, data["max_files"], data["max_bytes"], dest_dir,
        )
    except Exception as exc:  # noqa: BLE001 - any download/combine failure is sanitized + surfaced
        repo.set_status(conn, import_id, "failed")
        repo.mark_files(conn, import_id, "failed")
        shutil.rmtree(dest_dir, ignore_errors=True)
        runs_repo.set_status(conn, analysis_run_id, "failed",
                             final_summary="Evidence import failed before analysis could run.")
        audit.record(conn, "evidence_import.failed",
                     {"import_id": import_id, "error": safe_err(exc)}, run_id=None)
        conn.commit()
        raise ImportServiceError(400, f"evidence download failed: {safe_err(exc)}") from exc

    try:
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
    except Exception as exc:  # noqa: BLE001 - persist failure must not wedge the import
        repo.set_status(conn, import_id, "failed")
        repo.mark_files(conn, import_id, "failed")
        shutil.rmtree(dest_dir, ignore_errors=True)
        runs_repo.set_status(conn, analysis_run_id, "failed",
                             final_summary="Evidence import failed while persisting the dataset.")
        audit.record(conn, "evidence_import.failed",
                     {"import_id": import_id, "error": safe_err(exc)}, run_id=None)
        conn.commit()
        raise ImportServiceError(500, f"evidence import failed: {safe_err(exc)}") from exc

    # First-class Artifact: index the imported evidence snapshot against the
    # task that owns it (best-effort; never fails the import).
    from ..repositories import sessions as sessions_repo
    from ..task_runtime import artifacts as task_artifacts
    if not task_id and data.get("account_run_id"):
        task_id = sessions_repo.session_id_for_run(conn, data["account_run_id"])
    if task_id:
        sessions_repo.link_run(conn, task_id, analysis_run_id, sessions_repo.RUN_ROLE.get(run_type))
    task_artifacts.record_evidence_import(
        conn, task_id, import_id, source_type=source_type,
        summary=f"{len(files)} files, {total} bytes from {data['source_bucket']}")
    conn.commit()

    # Hand off to the existing deterministic analysis executor.
    run_service.start(analysis_run_id)
    return {"import_id": import_id, "status": "imported", "analysis_run_id": analysis_run_id,
            "downloaded_file_count": len(files), "downloaded_total_bytes": total}
