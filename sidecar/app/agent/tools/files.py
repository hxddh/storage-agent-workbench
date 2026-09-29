"""Local file analysis and evidence import (v5 registry)."""

from __future__ import annotations

import json
from typing import Any

from ...analysis.aggregate import AggregateError
from ...engines import datasets, evidence
from .registry import Scope, current, tool


def _own(dataset_id: str) -> dict[str, Any] | None:
    ctx = current()
    ds = datasets.get(ctx.conn(), dataset_id)
    return ds if ds and ds["task_id"] == ctx.task_id else None


@tool(group="files", core=True, timeout=15)
def list_uploaded_files() -> dict[str, Any]:
    """List the files attached to this task and the evidence imported into it (dataset_id, type, size,
    rows once analyzed).
    """
    rows = datasets.list_for_task(current().conn(), current().task_id)
    return {"success": True, "datasets": [
        {"dataset_id": d["id"], "origin": d["origin"], "type": d["dataset_type"], "filename": d["filename"],
         "size_bytes": d["size_bytes"], "rows": d.get("row_count"), "status": d["status"],
         **({"bucket": d["bucket"]} if d.get("bucket") else {})} for d in rows]}


@tool(group="files", timeout=600, summarize=lambda r: (f"{(r or {}).get('rows') or 0} rows · "
                                                      f"{len((r or {}).get('findings') or [])} findings")
      if isinstance(r, dict) and r.get("success") else "could not analyze")
def analyze_uploaded_file(dataset_id: str) -> dict[str, Any]:
    """Analyze an attached access log or inventory deterministically: request mix, error rates, latency,
    egress, top clients and hot prefixes (logs); object counts, sizes, age, storage classes and prefixes
    (inventory). Raw rows never leave the machine; truncated ingests are flagged.

    Args:
        dataset_id: From list_uploaded_files.
    """
    ds = _own(dataset_id)
    if ds is None:
        return {"error": "Unknown dataset_id for this task. Call list_uploaded_files."}
    return datasets.analyze(current().conn(), ds)


@tool(group="files", timeout=300, bounds={"limit": (1, 50)})
def aggregate_uploaded_file(dataset_id: str, metric: str, group_by: str = "", group_by_2: str = "",
                            filters_json: str = "", status_min: int = 0, status_max: int = 0,
                            limit: int = 20) -> dict[str, Any]:
    """One whitelisted aggregation over an attached or imported dataset — e.g. requests or bytes by
    client, prefix, status or hour; objects or bytes by storage class or prefix. Use to answer a follow-up
    question from the data already here, without a new import.

    Args:
        dataset_id: From list_uploaded_files.
        metric: A whitelisted metric (see allowed_metrics in an error reply).
        group_by: A whitelisted dimension.
        group_by_2: A second dimension.
        filters_json: JSON object of dimension filters, e.g. {"status": "403"}.
        status_min: Lowest HTTP status to include (logs).
        status_max: Highest HTTP status to include (logs).
        limit: Groups to return (1-50).
    """
    ds = _own(dataset_id)
    if ds is None:
        return {"error": "Unknown dataset_id for this task. Call list_uploaded_files."}
    try:
        filters = json.loads(filters_json) if filters_json else None
        if filters is not None and not isinstance(filters, dict):
            raise ValueError("filters_json must be a JSON object")
        return datasets.aggregate(current().conn(), ds, metric=metric, group_by=group_by, group_by_2=group_by_2,
                                  filters=filters, status_min=status_min or None, status_max=status_max or None,
                                  limit=limit)
    except (AggregateError, ValueError) as exc:
        return {"error": str(exc)[:300], "allowed": datasets.allowed_surface()}


@tool(group="files", scope=Scope(), timeout=900,
      summarize=lambda r: (f"imported {r.get('files')} files · {r.get('coverage')}" if isinstance(r, dict)
                           and r.get("success") else str((r or {}).get("error", "not imported"))[:160]))
def import_evidence(provider_id: str, bucket: str, source_type: str, time_range_start: str = "",
                    time_range_end: str = "", max_files: int = 500, max_bytes: int = 268435456) -> dict[str, Any]:
    """Import a DISCOVERED evidence source — the bucket's S3 Inventory or its server access logs — onto
    this machine and analyze it. The only data-moving action: bounded to 500 files / 256 MiB per call
    (clamped), refused without disk headroom, audited, stoppable. Say in your answer what you imported
    and whether coverage is partial. Afterwards use aggregate_uploaded_file on the new dataset.

    Args:
        provider_id: The provider.
        bucket: The bucket whose evidence to import (found by survey_account).
        source_type: inventory or access_log.
        time_range_start: ISO-8601 start (access_log only).
        time_range_end: ISO-8601 end (access_log only).
        max_files: At most 500.
        max_bytes: At most 256 MiB.
    """
    ctx = current()
    if ctx.cancelled:
        return {"error": "Stopped before the import started; nothing was downloaded."}

    def on_file(done: int, total: int, unit: str = "files") -> None:
        ctx.progress(done, total, unit)

    try:
        return evidence.import_source(ctx.conn(), task_id=ctx.task_id, provider_id=provider_id, bucket=bucket,
                                      source_type=source_type, time_range_start=time_range_start or None,
                                      time_range_end=time_range_end or None, max_files=max_files,
                                      max_bytes=max_bytes, on_file=on_file, cancel_event=ctx.turn.cancel)
    except evidence.ImportRefused as exc:
        return {"error": str(exc)}
