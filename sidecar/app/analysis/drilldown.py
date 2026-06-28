"""Safe, bounded drill-down over a run's already-local DuckDB dataset (Phase 2).

The deterministic analysis pass computes the base metrics; this lets the
interpretation narrator ask a few *follow-up* aggregate questions over the same
local table so it can investigate ("the spike is 5xx — which prefixes?") instead
of being frozen to one pre-computed view.

What it deliberately does NOT allow — the security envelope is enforced in code,
not the prompt:

- NO free SQL. Only two shapes run: ``aggregate_by`` (GROUP BY one whitelisted
  dimension, one whitelisted aggregate) and ``count_where`` (a single COUNT with
  one whitelisted field / operator / bound value).
- NO raw rows / object bodies. Every query is an aggregate; per-object columns
  (``key``, ``request_id``, ``raw_sanitized``, ``etag``) are never selectable as
  a dimension or returned.
- Dimensions/metrics/fields are validated against a per-table allow-list before
  any interpolation; the filter VALUE is always passed as a bound parameter
  (never string-formatted), so injection is impossible.
- The connection is opened read-only and results are capped + redacted.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import duckdb

from ..security.redaction import redact_text
from .inventory import _AGE_CASE, _SIZE_CASE

MAX_LIMIT = 50

# Comparison operators allowed in count_where (value is always bound, not inlined).
_OPS = {"=", "!=", "<", "<=", ">", ">="}


# Per-table whitelist. ``dimensions``/``metrics`` map a safe public name to the
# SQL expression used; ``filters`` maps a field to whether it is numeric.
_TABLES: dict[str, dict[str, Any]] = {
    "access_logs": {
        "dimensions": {
            "method": "method",
            "status_code": "status_code",
            "error_code": "error_code",
            "prefix": "prefix",
            "user_agent": "user_agent",
        },
        "metrics": {
            "count": "count(*)",
            "bytes": "COALESCE(sum(try_cast(bytes_sent AS BIGINT)), 0)",
            "avg_latency_ms": "COALESCE(avg(try_cast(latency_ms AS DOUBLE)), 0)",
        },
        "filters": {
            "status_code": True,
            "method": False,
            "error_code": False,
            "prefix": False,
        },
    },
    "inventory_objects": {
        "dimensions": {
            "storage_class": "storage_class",
            "prefix": "prefix",
            "size_bucket": _SIZE_CASE,
            "age_bucket": _AGE_CASE,
        },
        "metrics": {
            "count": "count(*)",
            "total_size": "COALESCE(sum(try_cast(size AS BIGINT)), 0)",
            "avg_size": "COALESCE(avg(try_cast(size AS BIGINT)), 0)",
        },
        "filters": {
            "storage_class": False,
            "size": True,
            "prefix": False,
        },
    },
}


class DrillError(ValueError):
    """A drill-down request that fails validation (safe to surface)."""


def _spec(table: str) -> dict[str, Any]:
    spec = _TABLES.get(table)
    if spec is None:
        raise DrillError(f"unknown dataset table: {table!r}")
    return spec


def dimensions(table: str) -> list[str]:
    return list(_spec(table)["dimensions"].keys())


def metrics(table: str) -> list[str]:
    return list(_spec(table)["metrics"].keys())


def filters(table: str) -> list[str]:
    return list(_spec(table)["filters"].keys())


def _connect(duckdb_path: str | Path) -> duckdb.DuckDBPyConnection:
    return duckdb.connect(str(duckdb_path), read_only=True)


def aggregate_by(
    duckdb_path: str | Path, table: str, dimension: str, metric: str = "count", limit: int = 20
) -> list[dict[str, Any]]:
    """GROUP BY one whitelisted dimension, ordered by one whitelisted metric.

    Returns ``[{"group": <value>, "value": <number>}, …]`` (≤ MAX_LIMIT rows),
    dimension values redacted + truncated.
    """
    spec = _spec(table)
    if dimension not in spec["dimensions"]:
        raise DrillError(f"dimension must be one of {dimensions(table)}")
    if metric not in spec["metrics"]:
        raise DrillError(f"metric must be one of {metrics(table)}")
    n = max(1, min(int(limit or 20), MAX_LIMIT))
    dim_expr = spec["dimensions"][dimension]
    met_expr = spec["metrics"][metric]
    sql = (
        f"SELECT {dim_expr} AS g, {met_expr} AS v "  # exprs come from the whitelist
        f"FROM {table} GROUP BY g ORDER BY v DESC LIMIT {n}"
    )
    con = _connect(duckdb_path)
    try:
        rows = con.execute(sql).fetchall()
    finally:
        con.close()
    out: list[dict[str, Any]] = []
    for g, v in rows:
        gval = redact_text(str(g))[:120] if g is not None else None
        out.append({"group": gval, "value": v})
    return out


def count_where(duckdb_path: str | Path, table: str, field: str, op: str, value: str) -> int:
    """COUNT(*) where one whitelisted field compares to a bound value."""
    spec = _spec(table)
    if field not in spec["filters"]:
        raise DrillError(f"field must be one of {filters(table)}")
    if op not in _OPS:
        raise DrillError(f"op must be one of {sorted(_OPS)}")
    numeric = spec["filters"][field]
    if numeric:
        try:
            bound: Any = float(value) if ("." in str(value)) else int(value)
        except (TypeError, ValueError) as exc:
            raise DrillError(f"value for {field} must be numeric") from exc
        # try_cast keeps a malformed row from aborting the whole count.
        predicate = f"try_cast({field} AS DOUBLE) {op} ?"
    else:
        bound = str(value)
        predicate = f"{field} {op} ?"
    sql = f"SELECT count(*) FROM {table} WHERE {predicate}"
    con = _connect(duckdb_path)
    try:
        return int(con.execute(sql, [bound]).fetchone()[0])
    finally:
        con.close()


__all__ = [
    "MAX_LIMIT", "DrillError", "dimensions", "metrics", "filters",
    "aggregate_by", "count_where",
]
