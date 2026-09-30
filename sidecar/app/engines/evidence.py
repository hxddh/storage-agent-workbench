"""Evidence import (v5): the one data-moving operation, bounded server-side.

Only a source the survey DISCOVERED (an S3 Inventory destination or a
server-access-logging target) can be imported, at most 500 files / 256 MiB per
call (clamped), refused without 1 GiB of free disk after the download (the
decompressed output is budgeted against the same headroom while it is written), and
stoppable between files. The download lands as a local dataset and is analyzed
deterministically right away; nothing is ever written to storage.
"""

from __future__ import annotations

import shutil
import uuid
from typing import Any, Callable

from .. import config
from ..core import store as core_store
from ..evidence import managed_import as mi
from ..security.redaction import redact_text
from . import datasets

MAX_FILES = 500
MAX_BYTES = 256 * 1024 * 1024
DISK_HEADROOM = 1024 * 1024 * 1024
_ALIAS = {"access_log": "server_access_logging", "inventory": "inventory"}


class ImportRefused(Exception):
    """Nothing was downloaded; the message says why and is safe to show."""


def _clamp(value: int | None, ceiling: int) -> int:
    try:
        v = int(value) if value else ceiling
    except (TypeError, ValueError):
        v = ceiling
    return max(1, min(v, ceiling))


def find_source(conn: Any, provider_id: str, bucket: str, source_type: str) -> dict[str, Any] | None:
    """The newest survey of this account that discovered the source for this bucket."""
    target = _ALIAS[source_type]
    for r in conn.execute("SELECT payload FROM artifacts WHERE kind = 'survey' AND provider_id = ? "
                          "ORDER BY created_at DESC, rowid DESC LIMIT 5", (provider_id,)).fetchall():
        profile = core_store.loads(r["payload"], {})
        for b in profile.get("buckets") or []:
            if b.get("bucket_name") != bucket:
                continue
            for s in b.get("evidence_sources") or []:
                if s.get("source_type") == target and s.get("status") == "available":
                    return s.get("detail") or {}
    return None


def import_source(conn: Any, *, task_id: str, provider_id: str, bucket: str, source_type: str,
                  time_range_start: str | None = None, time_range_end: str | None = None,
                  max_files: int | None = None, max_bytes: int | None = None,
                  on_file: Callable[[int, int, str], None] | None = None,
                  cancel_event: Any = None) -> dict[str, Any]:
    if source_type not in _ALIAS:
        raise ImportRefused("source_type must be 'inventory' or 'access_log'.")
    detail = find_source(conn, provider_id, bucket, source_type)
    if detail is None:
        raise ImportRefused(f"No discovered {source_type} source for bucket '{bucket}'. Run survey_account first "
                            "— only a source the survey discovered can be imported.")
    files_cap, bytes_cap = _clamp(max_files, MAX_FILES), _clamp(max_bytes, MAX_BYTES)
    # Planning lists the SOURCE (the inventory destination or the logging target),
    # which can be another bucket: it must be in the account's scope too.
    if source_type == "inventory":
        cfg0 = (detail.get("configurations") or [{}])[0]
        src_bucket, src_prefix = cfg0.get("destination_bucket"), cfg0.get("destination_prefix") or ""
    else:
        src_bucket, src_prefix = detail.get("target_bucket"), detail.get("target_prefix") or ""
    from ..providers import clouds
    from ..s3.scope import check_scope
    cloud = clouds.get(conn, provider_id)
    if cloud is not None and src_bucket:
        denial = check_scope(cloud.allowed_buckets, cloud.allowed_prefixes, src_bucket, prefix=src_prefix,
                             listing=True)
        if denial:
            raise ImportRefused(f"The evidence source is outside this account's scope: {denial}")
    if source_type == "inventory":
        cfg = (detail.get("configurations") or [{}])[0]
        if not cfg.get("destination_bucket"):
            raise ImportRefused("The inventory destination bucket is unknown.")
        plan = mi.plan_inventory(conn, provider_id, cfg["destination_bucket"], cfg.get("destination_prefix") or "",
                                 evidence_ref=cfg.get("inventory_id"), declared_format=cfg.get("format"),
                                 max_files=files_cap, max_bytes=bytes_cap)
    else:
        if not time_range_start or not time_range_end:
            raise ImportRefused("An access-log import needs time_range_start and time_range_end (ISO-8601).")
        if not detail.get("target_bucket"):
            raise ImportRefused("The logging target bucket is unknown.")
        plan = mi.plan_access_log(conn, provider_id, detail["target_bucket"], detail.get("target_prefix") or "",
                                  evidence_ref="server_access_logging", time_range_start=time_range_start,
                                  time_range_end=time_range_end, max_files=files_cap, max_bytes=bytes_cap)
    if not plan.selected:
        raise ImportRefused("Nothing to import: " + ("; ".join(plan.warnings[:3]) or "no matching objects") + ".")
    try:
        free = shutil.disk_usage(config.data_dir()).free
    except OSError:
        free = None
    if free is not None and free - plan.selected_total_bytes < DISK_HEADROOM:
        raise ImportRefused("Not enough free disk space for this import; nothing was downloaded.")
    did = uuid.uuid4().hex
    dest_dir = config.ensure_secure_dir(datasets.dataset_dir(task_id, did) / "raw")
    files = [{"object_key": f.get("object_key") or f.get("key"), "size": f.get("size")} for f in plan.selected]
    try:
        # The check above bounds the download; decompressed output is budgeted
        # against the same headroom while it is written (gzip can expand ~1000x).
        combined, total = mi.download_and_combine(conn, provider_id, plan.source_type, plan.source_bucket,
                                                  plan.fmt, plan.schema, files, plan.max_files, plan.max_bytes,
                                                  dest_dir, on_file=on_file, cancel_event=cancel_event,
                                                  disk_headroom=DISK_HEADROOM)
    except mi.LimitExceeded as exc:
        shutil.rmtree(datasets.dataset_dir(task_id, did), ignore_errors=True)
        raise ImportRefused(f"The import was stopped and nothing was kept: {redact_text(str(exc))[:200]}.") from exc
    except Exception:
        shutil.rmtree(datasets.dataset_dir(task_id, did), ignore_errors=True)
        raise
    partial = bool(plan.warnings) or len(plan.selected) < plan.planned_file_count
    ds = datasets.register(conn, task_id, dataset_type=source_type, filename=combined.name, path=combined,
                           provider_id=provider_id, bucket=bucket,
                           detail={"files": len(files), "bytes": total, "partial": partial,
                                   "source_bucket": plan.source_bucket, "source_prefix": plan.source_prefix,
                                   "warnings": [redact_text(w)[:200] for w in plan.warnings[:5]]})
    core_store.audit(conn, actor="agent", action="evidence.import", task_id=task_id, target=bucket,
                     detail={"source_type": source_type, "files": len(files), "bytes": total,
                             "approved_by": "agent", "bounds": {"files": files_cap, "bytes": bytes_cap}})
    analysis = datasets.analyze(conn, ds)
    return {"success": True, "dataset_id": ds["id"], "files": len(files), "bytes": total,
            "coverage": "partial" if partial else "complete",
            "bounds": {"max_files": files_cap, "max_bytes": bytes_cap},
            "warnings": [redact_text(w)[:200] for w in plan.warnings[:5]], "analysis": analysis}
