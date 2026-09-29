"""Local file analysis and evidence import (v5 registry)."""

from __future__ import annotations

import json
from typing import Any, Literal

from ...analysis.aggregate import AggregateError
from ...engines import datasets, evidence
from .registry import Scope, current, plural, tool

_SURFACE = datasets.allowed_surface()
# The whitelisted aggregation surface, spelled out in the schema (both dataset kinds).
Metric = Literal[tuple(sorted({m for s in _SURFACE.values() for m in s["metrics"]}))]  # type: ignore[valid-type]
Dimension = Literal[tuple(sorted({d for s in _SURFACE.values() for d in s["group_by"]}))]  # type: ignore[valid-type]


def _own(dataset_id: str) -> dict[str, Any] | None:
    ctx = current()
    ds = datasets.get(ctx.conn(), dataset_id)
    return ds if ds and ds["task_id"] == ctx.task_id else None


@tool(group="files", core=True, timeout=15,
      summarize=lambda r: plural(len((r or {}).get("datasets") or []), "file") if isinstance(r, dict) else "listed")
def list_uploaded_files() -> dict[str, Any]:
    """The files attached to this task and the evidence imported into it (dataset_id, type, size, rows)."""
    rows = datasets.list_for_task(current().conn(), current().task_id)
    return {"success": True, "datasets": [
        {"dataset_id": d["id"], "origin": d["origin"], "type": d["dataset_type"], "filename": d["filename"],
         "size_bytes": d["size_bytes"], "rows": d.get("row_count"), "status": d["status"],
         **({"bucket": d["bucket"]} if d.get("bucket") else {})} for d in rows]}


@tool(group="files", timeout=600, summarize=lambda r: (f"{plural(int((r or {}).get('rows') or 0), 'row')}, "
                                                      f"{plural(len((r or {}).get('findings') or []), 'finding')}")
      if isinstance(r, dict) and r.get("success") else "could not analyze")
def analyze_uploaded_file(dataset_id: str) -> dict[str, Any]:
    """Analyze an access log (request mix, errors, latency, egress, top clients and prefixes) or an
    inventory (counts, sizes, ages, storage classes, prefixes). Raw rows stay on this machine.

    Args:
        dataset_id: From list_uploaded_files.
    """
    ds = _own(dataset_id)
    if ds is None:
        return {"error": "Unknown dataset_id for this task. Call list_uploaded_files."}
    return datasets.analyze(current().conn(), ds)


@tool(group="files", timeout=300, bounds={"limit": (1, 50)},
      summarize=lambda r: plural(len((r or {}).get("rows") or (r or {}).get("groups") or []), "group")
      if isinstance(r, dict) and not r.get("error") else str((r or {}).get("error") or "could not aggregate"))
def aggregate_uploaded_file(dataset_id: str, metric: Metric, group_by: Dimension | None = None,
                            group_by_2: str = "", filters_json: str = "", status_min: int = 0,
                            status_max: int = 0, limit: int = 20) -> dict[str, Any]:
    """One whitelisted aggregation over an attached or imported dataset, e.g. requests or bytes by client,
    prefix, status or hour; objects or bytes by storage class or prefix.

    Args:
        dataset_id: From list_uploaded_files.
        group_by_2: A second dimension (a group_by value).
        filters_json: JSON object of dimension filters, e.g. {"status_code": "403"}.
        status_min: Lowest HTTP status (logs).
        status_max: Highest HTTP status (logs).
        limit: Groups to return (1-50).
    """
    ds = _own(dataset_id)
    if ds is None:
        return {"error": "Unknown dataset_id for this task. Call list_uploaded_files."}
    try:
        filters = json.loads(filters_json) if filters_json else None
        if filters is not None and not isinstance(filters, dict):
            raise ValueError("filters_json must be a JSON object")
        return datasets.aggregate(current().conn(), ds, metric=metric, group_by=group_by or "",
                                  group_by_2=group_by_2, filters=filters, status_min=status_min or None,
                                  status_max=status_max or None, limit=limit)
    except (AggregateError, ValueError) as exc:
        return {"error": str(exc)[:300], "allowed": datasets.allowed_surface()}


@tool(group="files", scope=Scope(), timeout=900,
      summarize=lambda r: (f"imported {plural(int(r.get('files') or 0), 'file')}"
                           + (", partial" if r.get("coverage") == "partial" else "") if isinstance(r, dict)
                           and r.get("success") else str((r or {}).get("error", "not imported"))))
def import_evidence(bucket: str, source_type: Literal["inventory", "access_log"], time_range_start: str = "",
                    time_range_end: str = "", max_files: int = 500, max_bytes: int = 268435456,
                    provider_id: str = "") -> dict[str, Any]:
    """Download and analyze a source the survey discovered (the bucket's inventory or access logs), at most
    500 files / 256 MiB per call.

    Args:
        bucket: The bucket whose evidence to import.
        source_type: Which discovered source.
        time_range_start: ISO-8601 start (access_log only).
        time_range_end: ISO-8601 end (access_log only).
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
                                      max_bytes=max_bytes, on_file=on_file, cancel_event=ctx.stop)
    except evidence.ImportRefused as exc:
        return {"error": str(exc)}
