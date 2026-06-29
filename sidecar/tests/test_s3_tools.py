"""Tests for the READ-ONLY S3 tools, exercised through the HTTP API.

A botocore Stubber stands in for the real S3 endpoint, so no live AWS / MinIO /
BOS credentials are needed. ``build_s3_client`` is monkeypatched to return the
stubbed client; ``load_provider`` still reads the real (test) DB row.
"""

import sqlite3
from datetime import datetime, timezone
from io import BytesIO

import boto3
import pytest
from botocore.response import StreamingBody
from botocore.stub import Stubber

from app import config
from app.s3 import client_factory

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
TOKEN = "FwoGZXIvYXdzEXAMPLEsessiontoken"
BUCKET = "bucket-alpha"


@pytest.fixture()
def cloud_id(client):
    body = {
        "name": "minio-local",
        "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com",
        "region": "us-east-1",
        "addressing_style": "path",
        "access_key": ACCESS,
        "secret_key": SECRET,
        "session_token": TOKEN,
        "mode": "readonly",
    }
    return client.post("/cloud-providers", json=body).json()["id"]


@pytest.fixture()
def stub(monkeypatch):
    """Yield (boto3 client, Stubber); patch the factory to return this client."""
    c = boto3.client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id="stub",
        aws_secret_access_key="stub",
        endpoint_url="https://minio.example.com",
    )
    s = Stubber(c)
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: c)
    s.activate()
    yield c, s
    s.deactivate()


def _db():
    return sqlite3.connect(str(config.db_path()))


# --- test_credentials -------------------------------------------------------


def test_credentials_success(client, cloud_id, stub):
    _, s = stub
    s.add_response("list_buckets", {"Buckets": [{"Name": "b1"}], "Owner": {"DisplayName": "acct"}})
    resp = client.post("/tools/test-credentials", json={"provider_id": cloud_id})
    body = resp.json()
    assert body["success"] is True
    assert body["identity_hint"] == "acct"
    assert body["provider_type"] == "s3-compatible"
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in resp.text


def test_credentials_unsupported_is_not_hard_failure(client, cloud_id, stub):
    _, s = stub
    s.add_client_error("list_buckets", service_error_code="NotImplemented", http_status_code=501)
    body = client.post("/tools/test-credentials", json={"provider_id": cloud_id}).json()
    assert body["success"] is True
    assert body["identity_hint"] == "Provider unsupported"


def test_credentials_auth_failure(client, cloud_id, stub):
    _, s = stub
    s.add_client_error("list_buckets", service_error_code="InvalidAccessKeyId", http_status_code=403)
    body = client.post("/tools/test-credentials", json={"provider_id": cloud_id}).json()
    assert body["success"] is False
    assert body["error_code"] == "InvalidAccessKeyId"


def test_cloud_provider_test_endpoint_runs_real_check(client, cloud_id, stub):
    _, s = stub
    s.add_response("list_buckets", {"Buckets": [], "Owner": {"ID": "abc"}})
    resp = client.post(f"/cloud-providers/{cloud_id}/test")
    assert resp.status_code == 200
    assert resp.json()["success"] is True


def test_cloud_provider_test_missing_is_404(client):
    assert client.post("/cloud-providers/nope/test").status_code == 404


# --- head_bucket ------------------------------------------------------------


def test_head_bucket_success(client, cloud_id, stub):
    _, s = stub
    s.add_response("head_bucket", {})
    body = client.post("/tools/head-bucket", json={"provider_id": cloud_id, "bucket": BUCKET}).json()
    assert body["success"] is True
    assert body["status_code"] == 200


def test_head_bucket_not_found(client, cloud_id, stub):
    _, s = stub
    s.add_client_error("head_bucket", service_error_code="404", http_status_code=404)
    body = client.post("/tools/head-bucket", json={"provider_id": cloud_id, "bucket": BUCKET}).json()
    assert body["success"] is False
    assert body["status_code"] == 404


# --- list_objects_v2 --------------------------------------------------------


def test_list_objects_v2_success_and_sample_cap(client, cloud_id, stub):
    _, s = stub
    contents = [{"Key": f"k{i}"} for i in range(50)]
    s.add_response(
        "list_objects_v2",
        {"KeyCount": 50, "Contents": contents, "CommonPrefixes": [{"Prefix": "logs/"}], "IsTruncated": True},
        expected_params={"Bucket": BUCKET, "Prefix": "", "MaxKeys": 50, "Delimiter": "/"},
    )
    body = client.post(
        "/tools/list-objects-v2", json={"provider_id": cloud_id, "bucket": BUCKET, "max_keys": 50}
    ).json()
    assert body["success"] is True
    assert body["key_count"] == 50
    assert len(body["sample_keys"]) == 20  # capped
    assert body["common_prefixes"] == ["logs/"]
    assert body["is_truncated"] is True


def test_list_objects_v2_max_keys_required(client, cloud_id):
    resp = client.post("/tools/list-objects-v2", json={"provider_id": cloud_id, "bucket": BUCKET})
    assert resp.status_code == 422  # missing max_keys


def test_list_objects_v2_clamped_to_hard_cap(client, cloud_id, stub):
    _, s = stub
    # The tool must clamp 999999 down to the 1000 hard cap before calling S3.
    s.add_response(
        "list_objects_v2",
        {"KeyCount": 0, "Contents": [], "IsTruncated": False},
        expected_params={"Bucket": BUCKET, "Prefix": "", "MaxKeys": 1000, "Delimiter": "/"},
    )
    body = client.post(
        "/tools/list-objects-v2",
        json={"provider_id": cloud_id, "bucket": BUCKET, "max_keys": 999999},
    ).json()
    assert body["success"] is True  # would raise StubAssertionError if MaxKeys != 1000


def test_list_objects_v2_paginates_and_lists_recursively(client, cloud_id, stub):
    """The agent can enumerate a big bucket: pass a continuation token and omit
    the delimiter to walk keys flat, getting the full page + the next token."""
    from app.s3 import tools as s3

    c, s = stub
    s.add_response(
        "list_objects_v2",
        {"KeyCount": 3, "Contents": [{"Key": "a"}, {"Key": "b"}, {"Key": "c"}],
         "IsTruncated": True, "NextContinuationToken": "TOK2"},
        # recursive → no Delimiter; continuation token threaded through.
        expected_params={"Bucket": BUCKET, "Prefix": "logs/", "MaxKeys": 1000,
                         "ContinuationToken": "TOK1"},
    )
    with _db() as conn:
        res = s3.list_objects_v2(conn, cloud_id, BUCKET, 1000, "logs/",
                                 continuation_token="TOK1", delimiter=None)
    assert res["success"] is True
    assert res["keys"] == ["a", "b", "c"]      # full page, not just a 20-sample
    assert res["next_token"] == "TOK2"          # caller pages until this is null
    assert res["is_truncated"] is True


def test_session_list_objects_caps_keys_in_context(client, cloud_id, monkeypatch):
    """The session list_objects tool caps the keys it hands the model per call
    (so paged enumeration can't flood context), while key_count stays exact."""
    import json as _json

    from app.agent_runtime import session_tools
    from app.s3 import tools as s3mod

    monkeypatch.setattr(s3mod, "list_objects_v2", lambda *a, **k: {
        "success": True, "key_count": 300, "keys": [f"k{i}" for i in range(300)],
        "sample_keys": [], "common_prefixes": [], "is_truncated": True, "next_token": "T",
    })

    class _FT:
        def __call__(self, fn):
            fn.name = fn.__name__
            return fn

    with _db() as conn:
        conn.row_factory = sqlite3.Row  # cloud_repo.get expects Row access
        tools = {t.name: t for t in session_tools.build(conn, _FT(), [])}
        out = _json.loads(tools["list_objects"](cloud_id, BUCKET))
    assert out["key_count"] == 300            # exact count preserved
    assert len(out["keys"]) == 200            # capped for context
    assert out["keys_truncated_in_context"] is True
    assert out["next_token"] == "T"           # can still page


# --- head_object ------------------------------------------------------------


def test_head_object_sanitizes_metadata(client, cloud_id, stub):
    _, s = stub
    s.add_response(
        "head_object",
        {
            "ContentLength": 1024,
            "ETag": '"etag-1"',
            "LastModified": datetime(2026, 6, 20, 12, 0, tzinfo=timezone.utc),
            "StorageClass": "STANDARD",
            "Metadata": {"team": "infra", "authorization": "Bearer leaky-token"},
        },
    )
    resp = client.post(
        "/tools/head-object", json={"provider_id": cloud_id, "bucket": BUCKET, "key": "a.txt"}
    )
    body = resp.json()
    assert body["success"] is True
    assert body["size"] == 1024
    assert body["metadata_sanitized"]["team"] == "infra"
    assert body["metadata_sanitized"]["authorization"] == "***REDACTED***"
    assert "leaky-token" not in resp.text


# --- test_range_get ---------------------------------------------------------


def test_range_get_rejects_open_ended(client, cloud_id, stub):
    body = client.post(
        "/tools/test-range-get",
        json={"provider_id": cloud_id, "bucket": BUCKET, "key": "a", "range_header": "bytes=0-"},
    ).json()
    assert body["success"] is False
    assert body["error_code"] == "RangeRequired"


def test_range_get_rejects_too_large(client, cloud_id, stub):
    body = client.post(
        "/tools/test-range-get",
        json={"provider_id": cloud_id, "bucket": BUCKET, "key": "a", "range_header": "bytes=0-5242880"},
    ).json()
    assert body["success"] is False
    assert body["error_code"] == "RangeTooLarge"


def test_range_get_bounded_read(client, cloud_id, stub):
    _, s = stub
    payload = b"0123456789"
    s.add_response(
        "get_object",
        {
            "Body": StreamingBody(BytesIO(payload), len(payload)),
            "ContentRange": "bytes 0-9/100",
            "ContentLength": 10,
        },
        expected_params={"Bucket": BUCKET, "Key": "a", "Range": "bytes=0-9"},
    )
    body = client.post(
        "/tools/test-range-get",
        json={"provider_id": cloud_id, "bucket": BUCKET, "key": "a", "range_header": "bytes=0-9"},
    ).json()
    assert body["success"] is True
    assert body["bytes_returned"] == 10
    assert body["content_range"] == "bytes 0-9/100"
    assert body["latency_ms"] is not None


# --- path style vs virtual host ---------------------------------------------


def test_path_style_vs_virtual_host_recommendation(client, cloud_id, monkeypatch):
    # Build two independent stubbed clients keyed by addressing style.
    def make(style_ok):
        c = boto3.client("s3", region_name="us-east-1", aws_access_key_id="x",
                         aws_secret_access_key="y", endpoint_url="https://minio.example.com")
        s = Stubber(c)
        if style_ok:
            s.add_response("head_bucket", {})
        else:
            s.add_client_error("head_bucket", service_error_code="SignatureDoesNotMatch", http_status_code=403)
        s.activate()
        return c

    virtual_client = make(False)
    path_client = make(True)

    def fake_build(conn, provider_id, addressing_style_override=None):
        return path_client if addressing_style_override == "path" else virtual_client

    monkeypatch.setattr(client_factory, "build_s3_client", fake_build)
    body = client.post(
        "/tools/test-path-style-vs-virtual-host", json={"provider_id": cloud_id, "bucket": BUCKET}
    ).json()
    assert body["recommendation"] == "path"
    assert body["path_style_result"]["success"] is True
    assert body["virtual_hosted_result"]["success"] is False


# --- inspect_tls ------------------------------------------------------------


def test_inspect_tls_graceful_error_no_network(client):
    # Port 1 refuses fast; no DNS egress, no subprocess.
    resp = client.post("/tools/inspect-tls", json={"endpoint_url": "https://127.0.0.1:1"})
    body = resp.json()
    assert body["tls_version"] is None
    assert body["error_message_sanitized"] is not None


def test_inspect_tls_strips_query_from_recorded_input(client):
    client.post(
        "/tools/inspect-tls",
        json={"endpoint_url": "https://127.0.0.1:1/p?X-Amz-Signature=abc123&X-Amz-Credential=AKIA/cred"},
    )
    conn = _db()
    try:
        row = conn.execute(
            "SELECT input_json_sanitized FROM tool_calls WHERE tool_name='inspect_tls'"
        ).fetchone()
    finally:
        conn.close()
    recorded = row[0]
    assert "X-Amz-Signature" not in recorded
    assert "abc123" not in recorded


# --- recording + no-leak ----------------------------------------------------


def test_tool_calls_and_audit_recorded_without_secrets(client, cloud_id, stub):
    _, s = stub
    s.add_response("list_buckets", {"Buckets": [], "Owner": {"DisplayName": "acct"}})
    client.post("/tools/test-credentials", json={"provider_id": cloud_id})

    conn = _db()
    try:
        tc = conn.execute(
            "SELECT tool_name, input_json_sanitized, output_json_sanitized, status FROM tool_calls"
        ).fetchall()
        al = conn.execute("SELECT payload_json_sanitized FROM audit_logs WHERE event_type LIKE 'tool.%'").fetchall()
    finally:
        conn.close()

    assert any(r[0] == "test_credentials" and r[3] == "success" for r in tc)
    blob = " ".join(str(c) for row in tc for c in row) + " ".join(str(r[0]) for r in al)
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in blob
