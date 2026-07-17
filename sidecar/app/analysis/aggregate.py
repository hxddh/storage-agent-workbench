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
def _ts_bucket(fmt: str) -> str:
    return (f"CASE WHEN try_cast(timestamp AS TIMESTAMP) IS NULL THEN 'unknown' "
            f"ELSE strftime(try_cast(timestamp AS TIMESTAMP), '{fmt}') END")


_HOUR_EXPR = _ts_bucket("%Y-%m-%dT%H:00")
# day / weekday let a multi-week log be bucketed at a coarser grain than hour.
# weekday sorts Sun..Sat via the leading %w digit; the name follows for the label.
_DAY_EXPR = _ts_bucket("%Y-%m-%d")
_WEEKDAY_EXPR = _ts_bucket("%w %A")
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
        "day": _DAY_EXPR,
        "weekday": _WEEKDAY_EXPR,
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
        "min_bytes": "min(bytes_sent)",
        "max_bytes": "max(bytes_sent)",
        "avg_latency_ms": "avg(latency_ms)",
        "p50_latency_ms": "quantile_cont(latency_ms, 0.5)",
        "p95_latency_ms": "quantile_cont(latency_ms, 0.95)",
        "p99_latency_ms": "quantile_cont(latency_ms, 0.99)",
        "max_latency_ms": "max(latency_ms)",
        "distinct_ips": "count(DISTINCT client_ip_masked)",
        "distinct_keys": "count(DISTINCT key)",
    },
    "inventory": {
        "count": "count(*)",
        "total_size": "sum(size)",
        "avg_size": "avg(size)",
        "max_size": "max(size)",
        "min_size": "min(size)",
        "distinct_prefixes": "count(DISTINCT prefix)",
        "distinct_storage_classes": "count(DISTINCT storage_class)",
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
    group_by_2: str | None = None,
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

    con = duck.connect(duckdb_path, read_only=True)
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
        # Optional SECOND dimension: e.g. "403s per masked-IP per hour". Both
        # identifiers resolve only from the whitelist (never caller text), so the
        # composite GROUP BY carries zero injection surface — only the vocabulary
        # widened, not the mechanism.
        dims = [group_by]
        if group_by_2:
            _require("group_by (2)", group_by_2, _DIMENSIONS[dataset_type])
            if group_by_2 != group_by:
                dims.append(group_by_2)
        dim_exprs = [_DIMENSIONS[dataset_type][d] for d in dims]
        if any(d in _KEYLIKE_DIMENSIONS for d in dims):
            limit = min(limit, DEFAULT_GROUPS)  # rule 16: don't stream 50 raw keys
        select_dims = ", ".join(f"{expr} AS g{i}" for i, expr in enumerate(dim_exprs))
        group_keys = ", ".join(f"g{i}" for i in range(len(dim_exprs)))
        # Deterministic ordering: primary metric DESC, then the group keys, so ties
        # don't shuffle which groups appear (or flip `truncated`) run-to-run.
        order_keys = ", ".join(f"g{i}" for i in range(len(dim_exprs)))
        # Fetch limit+1 to report (not silently drop) an over-limit tail.
        sql = (
            f"SELECT {select_dims}, {metric_sql} AS v FROM {table}{where_sql} "
            f"GROUP BY {group_keys} ORDER BY v DESC NULLS LAST, {order_keys} LIMIT {limit + 1}"
        )
        rows = con.execute(sql, params).fetchall()
    finally:
        con.close()

    n_dims = len(dim_exprs)
    truncated = len(rows) > limit

    def _label(row) -> str:
        parts = [redact_text(str(x))[:_LABEL_LEN] for x in row[:n_dims]]
        return " · ".join(parts)

    groups = [
        {"group": _label(row), "value": _num(row[n_dims])}
        for row in rows[:limit]
    ]
    return {
        "sql": sql, "params": list(params), "metric": metric,
        "group_by": group_by, "group_by_2": group_by_2 if len(dims) > 1 else None,
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
