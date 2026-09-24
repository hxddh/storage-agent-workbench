"""Tests for Phase 04 diagnostic runs and reports.

A botocore Stubber stands in for S3; runs execute synchronously through
``tests.runs_helper`` (``run_service.run_sync``) — no HTTP route creates or
starts a run, and there is no run event bus.
"""

import sqlite3
from types import SimpleNamespace

import boto3
import pytest
from botocore.stub import Stubber

from app import config, run_service
from app.s3 import client_factory

from . import runs_helper

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
TOKEN = "FwoGZXIvYXdzEXAMPLEsessiontoken"
BUCKET = "bucket-alpha"


def _db():
    return sqlite3.connect(str(config.db_path()))


@pytest.fixture()
def diag(client, monkeypatch):
    pid = client.post(
        "/cloud-providers",
        json={
            "name": "minio",
            "provider_type": "s3-compatible",
            "endpoint_url": "https://minio.example.com",
            "region": "us-east-1",
            "addressing_style": "path",
            "access_key": ACCESS,
            "secret_key": SECRET,
            "session_token": TOKEN,
            "mode": "readonly",
        },
    ).json()["id"]

    c = boto3.client(
        "s3", region_name="us-east-1", aws_access_key_id="stub",
        aws_secret_access_key="stub", endpoint_url="https://minio.example.com",
    )
    s = Stubber(c)
    s.activate()
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: c)
    # Execute runs synchronously and deterministically.
    monkeypatch.setattr(run_service, "start", run_service.run_sync)

    yield SimpleNamespace(client=client, pid=pid, stub=s)
    s.deactivate()


def _queue_success(s):
    s.add_response("list_buckets", {"Buckets": [], "Owner": {"DisplayName": "acct"}})
    s.add_response("head_bucket", {})
    s.add_response(
        "list_objects_v2",
        {"KeyCount": 2, "Contents": [{"Key": "a"}, {"Key": "b"}], "IsTruncated": False},
        expected_params={"Bucket": BUCKET, "Prefix": "", "MaxKeys": 100, "Delimiter": "/", "OptionalObjectAttributes": ["RestoreStatus"]},
    )


def _start_run(d, prompt="diagnose my bucket"):
    return runs_helper.run("diagnostic", provider_id=d.pid, bucket=BUCKET,
                           user_prompt=prompt, content=prompt)


# --- no HTTP submit path -----------------------------------------------------


def test_no_http_route_creates_or_starts_a_run(client):
    """The durable Agent Task runtime is the one submit path: the engines are
    reached through the Agent (``run_service``), never a ``/runs`` POST."""
    body = {"run_type": "diagnostic", "provider_id": "p1", "bucket": BUCKET, "user_prompt": "hi"}
    assert client.post("/runs", json=body).status_code == 405
    assert client.post("/runs/x/message", json={"content": "go"}).status_code in (404, 405)
    assert client.get("/runs/x/events").status_code == 404
    starting = [
        (sorted(r.methods), r.path) for r in client.app.routes
        if str(getattr(r, "path", "")).startswith("/runs")
        and (set(getattr(r, "methods", None) or ()) - {"GET", "HEAD", "DELETE"})
    ]
    assert starting == []
    import importlib.util
    assert importlib.util.find_spec("app.events") is None


def test_created_run_is_listed_pending(client):
    run_id = runs_helper.create_run("diagnostic", provider_id="p1", bucket=BUCKET,
                                    user_prompt="hi")
    listed = {x["id"]: x for x in client.get("/runs").json()}
    assert listed[run_id]["status"] == "pending"


def test_unknown_run_type_marks_run_failed(client):
    """run_service must not leave a run with an unexecutable run_type stuck
    pending: it marks it failed and closes the stream (fix 7)."""
    from app import db, run_service
    from app.repositories import utcnow

    conn = db.connect()
    try:
        conn.execute(
            "INSERT INTO runs (id, run_type, title, status, created_at, updated_at) "
            "VALUES ('bogus-run', 'not_a_real_type', 't', 'pending', ?, ?)",
            (utcnow(), utcnow()),
        )
        conn.commit()
    finally:
        conn.close()

    run_service.run_sync("bogus-run")

    conn = db.connect()
    try:
        row = conn.execute("SELECT status FROM runs WHERE id = 'bogus-run'").fetchone()
    finally:
        conn.close()
    assert row["status"] == "failed"


def test_tool_call_created_at_is_iso_z(diag):
    """created_at is the ISO-8601 UTC 'Z' format (not SQLite datetime('now')),
    so cross-table string sorts stay coherent (fix 14)."""
    _queue_success(diag.stub)
    run_id = _start_run(diag)
    conn = _db()
    try:
        rows = conn.execute("SELECT created_at FROM tool_calls WHERE run_id = ?", (run_id,)).fetchall()
        arows = conn.execute("SELECT created_at FROM audit_logs WHERE run_id = ?", (run_id,)).fetchall()
    finally:
        conn.close()
    assert rows and all(r[0].endswith("Z") and "T" in r[0] for r in rows)
    assert arows and all(r[0].endswith("Z") and "T" in r[0] for r in arows)


def test_interrupted_runs_reconciled_on_startup(client):
    """A run left pending/running by a prior process (in-process threads can't
    survive a restart) is failed on boot, so it never reports as forever-running."""
    from app import db, run_service
    from app.models.schemas import RunCreate
    from app.repositories import runs as runs_repo

    body = RunCreate(run_type="diagnostic", provider_id="p1", bucket=BUCKET, user_prompt="x")
    conn = db.connect()
    try:
        r_running = runs_repo.create(conn, body, status="running")
        r_pending = runs_repo.create(conn, body, status="pending")
        r_done = runs_repo.create(conn, body, status="completed")
        conn.commit()
    finally:
        conn.close()

    n = run_service.reconcile_interrupted_runs()
    assert n == 1

    conn = db.connect()
    try:
        assert runs_repo.get_row(conn, r_running)["status"] == "failed"
        # v0.41: pending = created-but-never-executed (and the retry revert
        # target) — it is NOT an interrupted run and must stay retryable.
        assert runs_repo.get_row(conn, r_pending)["status"] == "pending"
        assert "Interrupted" in (runs_repo.get_row(conn, r_running)["final_summary"] or "")
        assert runs_repo.get_row(conn, r_done)["status"] == "completed"  # untouched
    finally:
        conn.close()


# --- diagnostic flow --------------------------------------------------------


def test_diagnostic_invokes_three_tools_and_completes(diag):
    _queue_success(diag.stub)
    run_id = _start_run(diag)

    detail = diag.client.get(f"/runs/{run_id}").json()
    assert detail["status"] == "completed"
    tool_names = [t["tool_name"] for t in detail["tool_calls"]]
    # The 3 probes in order, then the report generation as its own audited
    # tool_call (v0.38: diagnostic now routes report writing through
    # run_tool_with_events like every other executor — rule 17).
    assert tool_names == ["test_credentials", "head_bucket", "list_objects_v2",
                          "generate_markdown_report"]
    assert detail["final_summary"]


def test_tool_calls_and_audit_have_run_id(diag):
    _queue_success(diag.stub)
    run_id = _start_run(diag)

    conn = _db()
    try:
        tc = conn.execute("SELECT run_id, tool_name FROM tool_calls").fetchall()
        al = conn.execute(
            "SELECT run_id FROM audit_logs WHERE event_type LIKE 'tool.%'"
        ).fetchall()
    finally:
        conn.close()
    # 3 probes + generate_markdown_report (v0.38: report gen is an audited tool).
    assert len(tc) == 4
    assert all(r[0] == run_id for r in tc)
    assert len(al) == 4
    assert all(r[0] == run_id for r in al)


def test_unhealthy_target_still_completes(diag):
    """A diagnostic that successfully RAN its probes completes even when the
    target is unhealthy (bucket 404). 'failed' is reserved for the executor
    itself failing — the unhealthy verdict lives in the summary/findings."""
    s = diag.stub
    s.add_response("list_buckets", {"Buckets": [], "Owner": {"DisplayName": "acct"}})
    s.add_client_error("head_bucket", service_error_code="404", http_status_code=404)
    s.add_response(
        "list_objects_v2",
        {"KeyCount": 0, "Contents": [], "IsTruncated": False},
        expected_params={"Bucket": BUCKET, "Prefix": "", "MaxKeys": 100, "Delimiter": "/", "OptionalObjectAttributes": ["RestoreStatus"]},
    )
    run_id = _start_run(diag)
    detail = diag.client.get(f"/runs/{run_id}").json()
    assert detail["status"] == "completed"
    # The verdict is prominent: the summary names the failed check.
    assert "issues" in (detail["final_summary"] or "").lower()
    assert "head_bucket" in (detail["final_summary"] or "")


# --- report -----------------------------------------------------------------


def test_report_generated_and_sanitized(diag):
    _queue_success(diag.stub)
    run_id = _start_run(diag)

    resp = diag.client.get(f"/reports/{run_id}")
    assert resp.status_code == 200
    content = resp.json()["content"]
    # required sections (no "## Plan" — the canned plan section was removed;
    # the real tool trace in ## Evidence stands in for it)
    for section in ("# Diagnostic Report", "## Summary", "## Scope",
                    "## Evidence", "## Findings", "## Limitations", "## Safety"):
        assert section in content
    assert "## Plan" not in content
    assert "not a full bucket scan" in content.lower() or "not** a full bucket scan" in content.lower()
    # no secrets
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in content

    # the report_path is now RELATIVE to the data dir; the file exists there.
    from pathlib import Path
    assert not Path(resp.json()["report_path"]).is_absolute()
    assert (config.data_dir() / resp.json()["report_path"]).exists()
