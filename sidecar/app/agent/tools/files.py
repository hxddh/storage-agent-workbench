"""Attached files and imported evidence (v10): one analysis tool and the import."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field

from ...analysis.aggregate import AggregateError
from ...engines import datasets, evidence
from .registry import Scope, current, plural, tool

# One metric vocabulary for both dataset kinds: bytes are bytes whether a log
# counted them sent or an inventory counted them stored.
Metric = Literal["count", "sum_bytes", "avg_bytes", "min_bytes", "max_bytes", "avg_latency_ms", "p50_latency_ms",
                 "p95_latency_ms", "p99_latency_ms", "max_latency_ms", "distinct_ips", "distinct_keys",
                 "distinct_prefixes", "distinct_storage_classes"]
_INVENTORY_METRIC = {"sum_bytes": "total_size", "avg_bytes": "avg_size", "min_bytes": "min_size",
                     "max_bytes": "max_size"}
_LOG_METRIC = {v: k for k, v in _INVENTORY_METRIC.items()}  # the retired inventory names still work
Dimension = Literal["status_code", "method", "error_code", "prefix", "key", "path", "user_agent", "client_ip_masked",
                    "hour", "day", "weekday", "storage_class", "bucket"]


def _datasets(ctx: Any) -> list[dict[str, Any]]:
    return datasets.list_for_task(ctx.conn(), ctx.task_id) if ctx.task_id else []


def _pick(ctx: Any, dataset_id: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """(dataset, None) or (None, an error that lists what this task holds)."""
    rows = _datasets(ctx)
    if dataset_id:
        ds = datasets.get(ctx.conn(), dataset_id)
        if ds and ds["task_id"] == ctx.task_id:
            return ds, None
    elif rows:
        return rows[-1], None  # the newest attachment or import
    held = [{"dataset_id": d["id"], "filename": d["filename"], "kind": d["dataset_type"]} for d in rows[-10:]]
    msg = "Unknown dataset_id for this task." if dataset_id else "This task has no attached or imported file."
    return None, {"error": msg + (" Use one of datasets." if held else " Attach a file or run import_evidence."),
                  **({"datasets": held} if held else {})}


def _metric(kind: str, metric: str) -> str:
    if kind == "inventory":
        return _INVENTORY_METRIC.get(metric, metric)
    return _LOG_METRIC.get(metric, metric)


def _summary(r: Any) -> str:
    if not isinstance(r, dict) or r.get("error"):
        return str((r or {}).get("error") or "could not analyze")
    if "groups" in r:
        return plural(len(r.get("groups") or []), "group")
    if "value" in r and r.get("metric"):
        return f"{r['metric']}: {r['value']}"
    if r.get("success"):
        return f"{plural(int(r.get('rows') or 0), 'row')}, {plural(len(r.get('findings') or []), 'finding')}"
    return "could not analyze"


@tool(group="files", core=True, timeout=600, bounds={"limit": (1, 50)}, summarize=_summary)
def analyze_uploaded_file(dataset_id: str = "", metric: Metric | None = None,
                          group_by: Annotated[list[Dimension], Field(max_length=2)] | None = None,
                          filters: dict[str, str] | None = None, status_min: int = 0, status_max: int = 0,
                          limit: int = 20) -> dict[str, Any]:
    """Analyze an attached or imported access log (requests, errors, latency, clients, prefixes) or
    inventory (counts, sizes, ages, classes). With metric: one aggregation instead. Raw rows stay local.

    Args:
        dataset_id: From the attachment line or import_evidence; omit for the newest.
        group_by: Up to two dimensions.
        filters: Equality filters, e.g. {"status_code": "403"}.
        limit: Groups (1-50).
    """
    ctx = current()
    ds, err = _pick(ctx, dataset_id)
    if ds is None:
        return err  # type: ignore[return-value]
    if not metric:
        if group_by or filters:
            return {"error": "group_by and filters need a metric (e.g. count or sum_bytes)."}
        return datasets.analyze(ctx.conn(), ds)
    kind = ds["dataset_type"]
    try:
        dims = [str(d) for d in (group_by or [])][:2]
        res = datasets.aggregate(ctx.conn(), ds, metric=_metric(kind, metric), group_by=dims[0] if dims else "",
                                 group_by_2=dims[1] if len(dims) > 1 else "", filters=filters or None,
                                 status_min=status_min or None, status_max=status_max or None, limit=limit)
    except (AggregateError, ValueError) as exc:
        return {"error": str(exc)[:300].replace("total_size", "sum_bytes").replace("avg_size", "avg_bytes")
                .replace("min_size", "min_bytes").replace("max_size", "max_bytes"), "kind": kind}
    if res.get("metric") in _LOG_METRIC:
        res["metric"] = _LOG_METRIC[res["metric"]]
    return {**res, "kind": kind}


@tool(group="files", scope=Scope(), timeout=900,
      summarize=lambda r: (f"imported {plural(int(r.get('files') or 0), 'file')}"
                           + (", partial" if r.get("coverage") == "partial" else "") if isinstance(r, dict)
                           and r.get("success") else str((r or {}).get("error", "not imported"))))
def import_evidence(bucket: str, source_type: Literal["inventory", "access_log"], time_range_start: str = "",
                    time_range_end: str = "", max_mib: int = 256, provider_id: str = "") -> dict[str, Any]:
    """Download and analyze the bucket's inventory or access logs, as the survey discovered them (at most
    500 files / 256 MiB per call).

    Args:
        time_range_start: access_log: ISO-8601.
        time_range_end: access_log: ISO-8601.
        max_mib: At most this many MiB (1-256).
    """
    ctx = current()
    if ctx.cancelled:
        return {"error": "Stopped before the import started; nothing was downloaded."}

    def on_file(done: int, total: int, unit: str = "files") -> None:
        ctx.progress(done, total, unit)

    try:
        mib = max(1, int(max_mib or 256))
    except (TypeError, ValueError):
        mib = 256
    try:
        return evidence.import_source(ctx.conn(), task_id=ctx.task_id, provider_id=provider_id, bucket=bucket,
                                      source_type=source_type, time_range_start=time_range_start or None,
                                      time_range_end=time_range_end or None, max_files=evidence.MAX_FILES,
                                      max_bytes=mib * 1024 * 1024, on_file=on_file, cancel_event=ctx.stop)
    except evidence.ImportRefused as exc:
        return {"error": str(exc)}
