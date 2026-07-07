"""Tests for Phase 04 diagnostic runs, SSE events, and reports.

A botocore Stubber stands in for S3; ``run_service.start`` is monkeypatched to
run synchronously so assertions are deterministic (no thread races).
"""

import json
import sqlite3
from types import SimpleNamespace

import boto3
import pytest
from botocore.stub import Stubber

from app import config, run_service
from app.s3 import client_factory

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
        expected_params={"Bucket": BUCKET, "Prefix": "", "MaxKeys": 100, "Delimiter": "/"},
    )


def _start_run(d, prompt="diagnose my bucket"):
    r = d.client.post(
        "/runs",
        json={"run_type": "diagnostic", "provider_id": d.pid, "bucket": BUCKET, "user_prompt": prompt},
    ).json()
    run_id = r["run_id"]
    d.client.post(f"/runs/{run_id}/message", json={"content": prompt})
    return run_id


# --- creation ---------------------------------------------------------------


def test_create_diagnostic_run(client):
    r = client.post(
        "/runs",
        json={"run_type": "diagnostic", "provider_id": "p1", "bucket": BUCKET, "user_prompt": "hi"},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "pending"
    assert body["run_id"]
    assert any(x["id"] == body["run_id"] for x in client.get("/runs").json())


def test_diagnostic_requires_fields(client):
    r = client.post("/runs", json={"run_type": "diagnostic", "provider_id": "p1"})
    assert r.status_code == 422


def test_unknown_run_type_is_rejected(client):
    # optimization_report was removed; an unknown run_type fails validation (422),
    # rather than being created as a not_implemented placeholder.
    r = client.post("/runs", json={"run_type": "optimization_report", "title": "later"})
    assert r.status_code == 422


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


def test_completed_run_rejects_second_message(diag):
    """A run that already ran can't have a second executor spawned over it (409)
    — guards against a concurrent/duplicate POST racing on the same row."""
    _queue_success(diag.stub)
    run_id = _start_run(diag)
    assert diag.client.get(f"/runs/{run_id}").json()["status"] == "completed"
    r = diag.client.post(f"/runs/{run_id}/message", json={"content": "again"})
    assert r.status_code == 409


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
    assert n >= 2

    conn = db.connect()
    try:
        assert runs_repo.get_row(conn, r_running)["status"] == "failed"
        assert runs_repo.get_row(conn, r_pending)["status"] == "failed"
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
    assert tool_names == ["test_credentials", "head_bucket", "list_objects_v2"]
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
    assert len(tc) == 3
    assert all(r[0] == run_id for r in tc)
    assert len(al) == 3
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
        expected_params={"Bucket": BUCKET, "Prefix": "", "MaxKeys": 100, "Delimiter": "/"},
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


# --- SSE --------------------------------------------------------------------


def test_sse_emits_required_events(diag):
    _queue_success(diag.stub)
    run_id = _start_run(diag)  # run already finished synchronously; events buffered

    resp = diag.client.get(f"/runs/{run_id}/events")
    assert resp.status_code == 200
    types = []
    for line in resp.text.splitlines():
        if line.startswith("data:"):
            types.append(json.loads(line[len("data:"):].strip())["type"])

    for required in ("tool_call_started", "tool_call_finished",
                     "summary", "finding", "report_ready"):
        assert required in types, f"missing SSE event: {required}"
    assert "plan" not in types  # no canned plan — the real tool trace stands in for it
    # exactly three tool start/finish pairs
    assert types.count("tool_call_started") == 3
    assert types.count("tool_call_finished") == 3


def test_sse_events_carry_no_secrets(diag):
    _queue_success(diag.stub)
    run_id = _start_run(diag)
    text = diag.client.get(f"/runs/{run_id}/events").text
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in text
