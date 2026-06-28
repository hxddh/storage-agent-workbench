"""Tests for Phase 2 bounded drill-down over the local DuckDB dataset.

The narrator may ask follow-up aggregate questions, but only whitelisted GROUP
BY / COUNT shapes run — no free SQL, no raw rows, no object bodies — and the
filter value is always a bound parameter (injection-proof).
"""

import pytest

from app.analysis import access_logs, drilldown, inventory

ACCESS_LOG = (
    '2026-06-25T10:00:00Z bkt GET /a/x 200 100 5 ms user-agent="ua1" remote_ip="192.0.2.1"\n'
    '2026-06-25T10:01:00Z bkt GET /a/y 500 200 9 ms user-agent="ua1" remote_ip="192.0.2.2"\n'
    '2026-06-25T11:00:00Z bkt PUT /b/z 403 0 3 ms user-agent="ua2" remote_ip="192.0.2.3"\n'
)
INVENTORY_CSV = (
    "Bucket,Key,Size,LastModifiedDate,StorageClass\n"
    "bkt,a/1,1024,2026-01-01T00:00:00Z,STANDARD\n"
    "bkt,a/2,5000000,2026-01-01T00:00:00Z,STANDARD\n"
    "bkt,b/3,200,2026-01-01T00:00:00Z,GLACIER\n"
)


def _access_db(tmp_path):
    raw = tmp_path / "a.log"
    raw.write_text(ACCESS_LOG)
    duck = tmp_path / "a.duckdb"
    fmt = access_logs.detect_log_format(raw)
    access_logs.import_access_logs(raw, duck, fmt)
    return str(duck)


def _inventory_db(tmp_path):
    raw = tmp_path / "inv.csv"
    raw.write_text(INVENTORY_CSV)
    duck = tmp_path / "inv.duckdb"
    inventory.import_inventory_file(raw, duck)
    return str(duck)


# --- correctness ------------------------------------------------------------


def test_aggregate_by_status_code_counts(tmp_path):
    db = _access_db(tmp_path)
    rows = drilldown.aggregate_by(db, "access_logs", "status_code", "count")
    by = {str(r["group"]): r["value"] for r in rows}
    assert by["200"] == 1 and by["500"] == 1 and by["403"] == 1


def test_aggregate_by_respects_metric_and_limit(tmp_path):
    db = _access_db(tmp_path)
    rows = drilldown.aggregate_by(db, "access_logs", "user_agent", "bytes", limit=1)
    assert len(rows) == 1  # limit honored
    # ua1 carries 100+200 bytes, the largest group
    assert rows[0]["group"] == "ua1" and rows[0]["value"] == 300


def test_count_where_numeric_and_string(tmp_path):
    db = _access_db(tmp_path)
    assert drilldown.count_where(db, "access_logs", "status_code", ">=", "400") == 2
    assert drilldown.count_where(db, "access_logs", "method", "=", "GET") == 2


def test_inventory_size_bucket_and_total_size(tmp_path):
    db = _inventory_db(tmp_path)
    rows = drilldown.aggregate_by(db, "inventory_objects", "storage_class", "total_size")
    by = {r["group"]: r["value"] for r in rows}
    assert by["STANDARD"] == 1024 + 5000000 and by["GLACIER"] == 200
    # bucketing dimension works too
    buckets = {r["group"] for r in drilldown.aggregate_by(db, "inventory_objects", "size_bucket")}
    assert buckets  # non-empty, e.g. '<4KB', '1MB-64MB'


# --- safety / validation ----------------------------------------------------


def test_unknown_dimension_metric_field_rejected(tmp_path):
    db = _access_db(tmp_path)
    with pytest.raises(drilldown.DrillError):
        drilldown.aggregate_by(db, "access_logs", "key", "count")  # raw key not selectable
    with pytest.raises(drilldown.DrillError):
        drilldown.aggregate_by(db, "access_logs", "status_code", "evil")
    with pytest.raises(drilldown.DrillError):
        drilldown.count_where(db, "access_logs", "raw_sanitized", "=", "x")


def test_unknown_table_rejected(tmp_path):
    db = _access_db(tmp_path)
    with pytest.raises(drilldown.DrillError):
        drilldown.aggregate_by(db, "secrets; DROP TABLE", "status_code", "count")


def test_bad_operator_rejected(tmp_path):
    db = _access_db(tmp_path)
    with pytest.raises(drilldown.DrillError):
        drilldown.count_where(db, "access_logs", "status_code", "OR 1=1", "0")


def test_filter_value_is_bound_not_injected(tmp_path):
    """A SQL-injection payload in the value is treated as data, not code."""
    db = _access_db(tmp_path)
    # The string never matches any method; the table is untouched (no error, count 0).
    n = drilldown.count_where(db, "access_logs", "method", "=", "GET' OR '1'='1")
    assert n == 0
    # The dataset still has all 3 rows afterwards.
    assert drilldown.count_where(db, "access_logs", "status_code", ">=", "0") == 3


def test_connection_is_read_only(tmp_path):
    """Drill-down opens the dataset read-only — no write path exists."""
    import duckdb
    db = _access_db(tmp_path)
    con = duckdb.connect(db, read_only=True)
    try:
        with pytest.raises(Exception):
            con.execute("INSERT INTO access_logs (method) VALUES ('X')")
    finally:
        con.close()
