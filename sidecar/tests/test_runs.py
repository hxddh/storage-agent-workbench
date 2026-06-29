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


def test_run_fails_on_tool_failure(diag):
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
    assert detail["status"] == "failed"


# --- report -----------------------------------------------------------------


def test_report_generated_and_sanitized(diag):
    _queue_success(diag.stub)
    run_id = _start_run(diag)

    resp = diag.client.get(f"/reports/{run_id}")
    assert resp.status_code == 200
    content = resp.json()["content"]
    # required sections
    for section in ("# Diagnostic Report", "## Summary", "## Scope", "## Plan",
                    "## Evidence", "## Findings", "## Limitations", "## Safety"):
        assert section in content
    assert "not a full bucket scan" in content.lower() or "not** a full bucket scan" in content.lower()
    # no secrets
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in content

    # the file really exists under the (temp) data dir
    from pathlib import Path
    assert Path(resp.json()["report_path"]).exists()


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
