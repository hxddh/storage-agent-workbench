"""Tests for Phase 05 DuckDB-backed access-log and inventory analysis.

Uses local sample files only (no live AWS/BOS/MinIO). Runs execute synchronously
via a monkeypatched run_service.start for deterministic assertions.
"""

import json
import sqlite3
from pathlib import Path

import pytest

from app import config, run_service
from app.analysis import access_logs, inventory

# --- sample data ------------------------------------------------------------

ACCESS_LOG_TEXT = (
    '2026-06-25T10:00:00Z bucket-alpha GET /datasets/train/part-0001.parquet 206 1048576 42 ms '
    'user-agent="aws-sdk/1.0" remote_ip="192.0.2.10"\n'
    '2026-06-25T10:00:01Z bucket-alpha GET /datasets/train/part-0001.parquet 206 1048576 40 ms '
    'user-agent="aws-sdk/1.0" remote_ip="192.0.2.11"\n'
    '2026-06-25T10:00:02Z bucket-alpha GET /private/secret.txt 403 0 12 ms '
    'user-agent="curl/8" remote_ip="192.0.2.12"\n'
    '2026-06-25T10:00:03Z bucket-alpha GET /missing.txt 404 0 10 ms '
    'user-agent="curl/8" remote_ip="192.0.2.13"\n'
)

ACCESS_LOG_JSONL = (
    json.dumps({"timestamp": "2026-06-25T11:00:00Z", "method": "GET", "path": "/a/b.txt",
                "status": 200, "bytes": 10, "user_agent": "Bearer sk-LEAK-TOKEN-123",
                "remote_ip": "203.0.113.7"}) + "\n"
)

INVENTORY_CSV = (
    "Bucket,Key,Size,LastModified,StorageClass,ETag\n"
    "b,datasets/train/p1.parquet,536870912,2026-06-20T12:00:00Z,STANDARD,e1\n"
    "b,datasets/train/p2.parquet,536870912,2024-01-01T12:00:00Z,STANDARD,e2\n"
    "b,logs/app.log,2048,2026-06-25T10:00:00Z,STANDARD_IA,e3\n"
    "b,tmp/small.txt,512,2026-06-25T09:00:00Z,STANDARD,e4\n"
)


def _write(tmp_path, name, content) -> Path:
    p = tmp_path / name
    p.write_text(content, encoding="utf-8")
    return p


def _db():
    return sqlite3.connect(str(config.db_path()))


# --- unit: access logs ------------------------------------------------------


def test_detect_log_format_text(tmp_path):
    p = _write(tmp_path, "a.log", ACCESS_LOG_TEXT)
    assert access_logs.detect_log_format(p)["format"] == "text"


def test_detect_log_format_jsonl(tmp_path):
    p = _write(tmp_path, "a.jsonl", ACCESS_LOG_JSONL)
    assert access_logs.detect_log_format(p)["format"] == "jsonl"


def test_import_access_logs_creates_duckdb_table(tmp_path):
    p = _write(tmp_path, "a.log", ACCESS_LOG_TEXT)
    duckdb_path = tmp_path / "a.duckdb"
    out = access_logs.import_access_logs(p, duckdb_path, "text")
    assert out["table_name"] == "access_logs"
    assert out["row_count"] == 4
    assert duckdb_path.exists()


def test_analyze_access_logs_metrics(tmp_path):
    p = _write(tmp_path, "a.log", ACCESS_LOG_TEXT)
    duckdb_path = tmp_path / "a.duckdb"
    access_logs.import_access_logs(p, duckdb_path, "text")
    m = access_logs.analyze_access_logs(duckdb_path)
    for key in ("total_requests", "status_code_distribution", "method_distribution",
                "requests_by_hour", "top_keys", "top_prefixes", "top_user_agents",
                "error_rate_4xx", "error_rate_5xx"):
        assert key in m
    assert m["total_requests"] == 4
    assert m["error_rate_4xx"] == 0.5  # one 403, one 404 of 4


def test_import_generic_text_log_ingests_raw_lines(tmp_path):
    """A generic application .log (not CLF/S3 format) must not crash or produce an
    empty table — every non-blank line is ingested as a raw row."""
    content = (
        "2026-06-25 10:00:00 INFO starting up, connecting to s3\n"
        "2026-06-25 10:00:01 WARN slow response from endpoint\n"
        "2026-06-25 10:00:02 ERROR upload failed: connection reset\n"
    )
    p = _write(tmp_path, "app.log", content)
    duckdb_path = tmp_path / "g.duckdb"
    out = access_logs.import_access_logs(p, duckdb_path, "text")
    assert out["row_count"] == 3  # all lines kept, no crash


def test_import_malformed_csv_does_not_crash(tmp_path):
    """A CSV-detected file with ragged rows must skip bad lines, not raise a
    ParserError (the original 问题2 crash)."""
    content = (
        "timestamp,method,status\n"
        "2026-06-25T10:00:00Z,GET,200\n"
        "2026-06-25T10:00:01Z,GET,200,extra,unexpected,columns\n"  # ragged
        "2026-06-25T10:00:02Z,GET,404\n"
    )
    p = _write(tmp_path, "ragged.csv", content)
    duckdb_path = tmp_path / "c.duckdb"
    out = access_logs.import_access_logs(p, duckdb_path, "csv")
    assert out["row_count"] >= 2  # good rows survive; ragged one skipped


def test_import_empty_file_raises_clear_error(tmp_path):
    p = _write(tmp_path, "empty.log", "\n  \n\n")
    duckdb_path = tmp_path / "e.duckdb"
    with pytest.raises(ValueError, match="No log lines could be read"):
        access_logs.import_access_logs(p, duckdb_path, "text")


def test_access_log_jsonl_masks_ip_and_redacts_secret(tmp_path):
    p = _write(tmp_path, "a.jsonl", ACCESS_LOG_JSONL)
    duckdb_path = tmp_path / "a.duckdb"
    access_logs.import_access_logs(p, duckdb_path, "jsonl")
    from app.analysis.duck import connect
    con = connect(duckdb_path)
    try:
        ua, ip = con.execute("SELECT user_agent, client_ip_masked FROM access_logs").fetchone()
    finally:
        con.close()
    assert "sk-LEAK-TOKEN-123" not in (ua or "")  # bearer token redacted
    assert ip == "203.0.113.x"  # IP masked


# --- unit: inventory --------------------------------------------------------


def test_import_inventory_csv(tmp_path):
    p = _write(tmp_path, "inv.csv", INVENTORY_CSV)
    duckdb_path = tmp_path / "i.duckdb"
    out = inventory.import_inventory_file(p, duckdb_path)
    assert out["table_name"] == "inventory_objects"
    assert out["row_count"] == 4


def test_import_inventory_parquet(tmp_path):
    pd = pytest.importorskip("pandas")
    pytest.importorskip("pyarrow")
    import io
    df = pd.read_csv(io.StringIO(INVENTORY_CSV))
    pq = tmp_path / "inv.parquet"
    df.to_parquet(pq)
    out = inventory.import_inventory_file(pq, tmp_path / "i.duckdb")
    assert out["format"] == "parquet"
    assert out["row_count"] == 4


def test_analyze_inventory_metrics(tmp_path):
    p = _write(tmp_path, "inv.csv", INVENTORY_CSV)
    duckdb_path = tmp_path / "i.duckdb"
    inventory.import_inventory_file(p, duckdb_path)
    m = inventory.analyze_inventory(duckdb_path)
    for key in ("object_count", "total_size", "average_object_size", "size_histogram",
                "prefix_distribution", "object_age_distribution",
                "storage_class_distribution", "small_object_ratio", "top_large_objects"):
        assert key in m
    assert m["object_count"] == 4
    buckets = {b["bucket"] for b in m["size_histogram"]}
    assert "512MB+" in buckets and "<4KB" in buckets
    # one object dated 2024 should land in 365d+
    age_buckets = {a["bucket"] for a in m["object_age_distribution"]}
    assert "365d+" in age_buckets
    prefixes = {pd["value"] for pd in m["prefix_distribution"]}
    assert "datasets/" in prefixes


def test_top_large_objects_capped_at_20(tmp_path):
    rows = ["Bucket,Key,Size,LastModified,StorageClass,ETag"]
    for i in range(50):
        rows.append(f"b,k{i}.bin,{1000000 - i},2026-01-01T00:00:00Z,STANDARD,e{i}")
    p = _write(tmp_path, "big.csv", "\n".join(rows) + "\n")
    duckdb_path = tmp_path / "i.duckdb"
    inventory.import_inventory_file(p, duckdb_path)
    m = inventory.analyze_inventory(duckdb_path)
    assert len(m["top_large_objects"]) == 20


# --- full run flow (HTTP) ---------------------------------------------------


@pytest.fixture()
def sync_runs(monkeypatch):
    monkeypatch.setattr(run_service, "start", run_service.run_sync)


def _run_analysis(client, run_type, dataset_type, filename, content, prompt):
    created = client.post(
        "/runs", json={"run_type": run_type, "user_prompt": prompt, "title": f"{run_type} test"}
    ).json()
    run_id = created["run_id"]
    up = client.post(
        f"/runs/{run_id}/datasets/upload",
        files={"file": (filename, content.encode(), "text/plain")},
        data={"dataset_type": dataset_type},
    )
    assert up.status_code == 200, up.text
    msg = client.post(f"/runs/{run_id}/message", json={"content": prompt})
    assert msg.status_code == 200
    return run_id


def test_access_log_run_end_to_end(client, sync_runs):
    run_id = _run_analysis(client, "access_log_analysis", "access_log",
                           "access.jsonl", ACCESS_LOG_JSONL + ACCESS_LOG_TEXT, "analyze logs")
    detail = client.get(f"/runs/{run_id}").json()
    assert detail["status"] == "completed"
    names = [t["tool_name"] for t in detail["tool_calls"]]
    assert "import_access_logs" in names and "analyze_access_logs" in names

    # tool_calls + audit_logs carry run_id
    conn = _db()
    try:
        tc = conn.execute("SELECT count(*) FROM tool_calls WHERE run_id=?", (run_id,)).fetchone()[0]
        al = conn.execute("SELECT count(*) FROM audit_logs WHERE run_id=? AND event_type LIKE 'tool.%'", (run_id,)).fetchone()[0]
    finally:
        conn.close()
    assert tc >= 4 and al >= 4

    report = client.get(f"/reports/{run_id}").json()["content"]
    assert "# Access Log Analysis Report" in report
    assert "sk-LEAK-TOKEN-123" not in report  # secret redacted
    assert "192.0.2.10" not in report          # IP masked
    assert "192.0.2.x" in report or "203.0.113.x" in report


def test_access_log_run_sse_events(client, sync_runs):
    run_id = _run_analysis(client, "access_log_analysis", "access_log",
                           "a.log", ACCESS_LOG_TEXT, "analyze")
    text = client.get(f"/runs/{run_id}/events").text
    types = [json.loads(l[5:].strip())["type"] for l in text.splitlines() if l.startswith("data:")]
    # No canned 'plan' event — runs expose their real tool trace, not a fixed plan.
    for required in ("tool_call_started", "tool_call_finished", "finding", "report_ready"):
        assert required in types
    assert "plan" not in types
    assert "192.0.2.10" not in text  # masked even in event stream


def test_inventory_run_end_to_end(client, sync_runs):
    run_id = _run_analysis(client, "inventory_analysis", "inventory",
                           "inv.csv", INVENTORY_CSV, "analyze inventory")
    detail = client.get(f"/runs/{run_id}").json()
    assert detail["status"] == "completed"
    names = [t["tool_name"] for t in detail["tool_calls"]]
    assert "import_inventory_file" in names and "analyze_inventory" in names

    report = client.get(f"/reports/{run_id}").json()["content"]
    assert "# Inventory Analysis Report" in report
    assert "Object Size Distribution" in report

    # dataset is listed and marked imported with run_id
    ds = client.get("/datasets").json()
    mine = [d for d in ds if d["run_id"] == run_id]
    assert mine and mine[0]["status"] == "imported"
    assert mine[0]["row_count"] == 4


def test_datasets_endpoint_lists_uploaded(client, sync_runs):
    run_id = _run_analysis(client, "inventory_analysis", "inventory",
                           "inv.csv", INVENTORY_CSV, "x")
    ds = client.get("/datasets").json()
    assert any(d["run_id"] == run_id and d["dataset_type"] == "inventory" for d in ds)
