"""Constrained, parameterized aggregation over an imported dataset.

The agent's escape hatch from the FIXED metric set — without breaking the
security floor. The agent chooses WHICH whitelisted aggregation to run (metric,
group-by dimension, equality/range filters); it can never:

- supply SQL (every identifier resolves from the hard whitelists below; a name
  outside them is a validation error, not an identifier);
- see raw rows (only grouped aggregates come back, capped at ``MAX_GROUPS``);
- exceed the sample discipline (group labels are redacted and length-capped).

All VALUES are bound as DuckDB parameters — nothing user- or model-controlled
is ever interpolated into the SQL string. The rendered SQL + parameters are
returned so the caller can audit them (rule 17: analysis SQL is recorded).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..security.redaction import redact_text
from . import duck

MAX_GROUPS = 50
DEFAULT_GROUPS = 20
_LABEL_LEN = 300

# Object-key-like dimensions are near-unique, so a GROUP BY on them degenerates
# into enumerating individual object keys one-per-group. Rule 16 caps sample
# object keys at 20, so these dimensions are clamped to DEFAULT_GROUPS regardless
# of the requested limit (other, genuinely-aggregating dimensions keep MAX_GROUPS).
_KEYLIKE_DIMENSIONS = {"key", "path"}

# Whitelisted GROUP BY dimensions per dataset type. Values are the exact SQL
# expressions used — constants defined HERE, never caller input. "hour" mirrors
# the derivation used by the fixed metric set.
_HOUR_EXPR = (
    "CASE WHEN try_cast(timestamp AS TIMESTAMP) IS NULL THEN 'unknown' "
    "ELSE strftime(try_cast(timestamp AS TIMESTAMP), '%Y-%m-%dT%H:00') END"
)
_DIMENSIONS: dict[str, dict[str, str]] = {
    "access_log": {
        "status_code": "status_code",
        "method": "method",
        "key": "key",
        "path": "path",
        "prefix": "prefix",
        "user_agent": "user_agent",
        "client_ip_masked": "client_ip_masked",
        "error_code": "error_code",
        "hour": _HOUR_EXPR,
    },
    "inventory": {
        "bucket": "bucket",
        "prefix": "prefix",
        "storage_class": "storage_class",
    },
}

# Whitelisted aggregate metrics per dataset type (name -> SQL aggregate).
_METRICS: dict[str, dict[str, str]] = {
    "access_log": {
        "count": "count(*)",
        "sum_bytes": "sum(bytes_sent)",
        "avg_bytes": "avg(bytes_sent)",
        "avg_latency_ms": "avg(latency_ms)",
        "p50_latency_ms": "quantile_cont(latency_ms, 0.5)",
        "p95_latency_ms": "quantile_cont(latency_ms, 0.95)",
        "max_latency_ms": "max(latency_ms)",
    },
    "inventory": {
        "count": "count(*)",
        "total_size": "sum(size)",
        "avg_size": "avg(size)",
        "max_size": "max(size)",
        "min_size": "min(size)",
    },
}

_TABLES = {"access_log": "access_logs", "inventory": "inventory_objects"}

# Columns filterable by equality, per dataset type (a subset of the dimensions —
# derived expressions like "hour" are not filterable).
_FILTERABLE = {
    "access_log": {"status_code", "method", "key", "path", "prefix",
                   "user_agent", "client_ip_masked", "error_code"},
    "inventory": {"bucket", "prefix", "storage_class"},
}


class AggregateError(ValueError):
    """Invalid aggregation request; the message lists the allowed values so the
    agent can self-correct on the next call."""


def _require(kind: str, value: str, allowed: dict[str, str] | set[str]) -> None:
    if value not in allowed:
        raise AggregateError(
            f"Unknown {kind} '{value}'. Allowed: {', '.join(sorted(allowed))}."
        )


def aggregate(
    duckdb_path: str | Path,
    dataset_type: str,
    metric: str,
    group_by: str | None = None,
    filters: dict[str, Any] | None = None,
    status_min: int | None = None,
    status_max: int | None = None,
    limit: int = DEFAULT_GROUPS,
) -> dict[str, Any]:
    """Run one whitelisted aggregation and return grouped (or scalar) results.

    Raises AggregateError on any out-of-whitelist request. Returns::

        {"sql": ..., "params": [...], "metric": ..., "group_by": ...,
         "groups": [{"group": label, "value": v}, ...],  # or "value": v
         "truncated": bool}
    """
    if dataset_type not in _TABLES:
        raise AggregateError(
            f"Unknown dataset_type '{dataset_type}'. Allowed: access_log, inventory."
        )
    table = _TABLES[dataset_type]
    _require("metric", metric, _METRICS[dataset_type])
    metric_sql = _METRICS[dataset_type][metric]

    where: list[str] = []
    params: list[Any] = []
    for col, val in (filters or {}).items():
        _require("filter column", col, _FILTERABLE[dataset_type])
        # Identifier from the whitelist; VALUE is always a bound parameter.
        where.append(f"{_DIMENSIONS[dataset_type][col]} = ?")
        params.append(val)
    if dataset_type == "access_log":
        if status_min is not None:
            where.append("status_code >= ?")
            params.append(int(status_min))
        if status_max is not None:
            where.append("status_code <= ?")
            params.append(int(status_max))
    elif status_min is not None or status_max is not None:
        raise AggregateError("status_min/status_max apply only to access_log datasets.")
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    limit = max(1, min(int(limit), MAX_GROUPS))

    con = duck.connect(duckdb_path)
    try:
        if group_by is None or group_by == "":
            sql = f"SELECT {metric_sql} FROM {table}{where_sql}"
            value = con.execute(sql, params).fetchone()[0]
            return {
                "sql": sql, "params": list(params), "metric": metric,
                "group_by": None,
                "value": _num(value), "truncated": False,
            }
        _require("group_by", group_by, _DIMENSIONS[dataset_type])
        dim_sql = _DIMENSIONS[dataset_type][group_by]
        if group_by in _KEYLIKE_DIMENSIONS:
            limit = min(limit, DEFAULT_GROUPS)  # rule 16: don't stream 50 raw keys
        # Fetch limit+1 to report (not silently drop) an over-limit tail.
        sql = (
            f"SELECT {dim_sql} AS g, {metric_sql} AS v FROM {table}{where_sql} "
            f"GROUP BY g ORDER BY v DESC NULLS LAST LIMIT {limit + 1}"
        )
        rows = con.execute(sql, params).fetchall()
    finally:
        con.close()

    truncated = len(rows) > limit
    groups = [
        {"group": redact_text(str(g))[:_LABEL_LEN], "value": _num(v)}
        for g, v in rows[:limit]
    ]
    return {
        "sql": sql, "params": list(params), "metric": metric, "group_by": group_by,
        "groups": groups, "truncated": truncated,
    }


def _num(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float):
        return round(value, 4)
    return int(value) if isinstance(value, int) else value


def allowed_surface() -> dict[str, Any]:
    """The whitelists, for tool docs/errors — what the agent may ask for."""
    return {
        dt: {"metrics": sorted(_METRICS[dt]), "group_by": sorted(_DIMENSIONS[dt]),
             "filters": sorted(_FILTERABLE[dt])}
        for dt in _TABLES
    }


__all__ = ["aggregate", "allowed_surface", "AggregateError", "MAX_GROUPS"]
