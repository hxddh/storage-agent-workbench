"""Tests for the READ-ONLY S3 tools.

A botocore Stubber stands in for the real S3 endpoint, so no live AWS / MinIO /
BOS credentials are needed. ``build_s3_client`` is monkeypatched to return the
stubbed client; ``load_provider`` still reads the real (test) DB row.

Only the two S3 tools with a surviving HTTP surface (``/tools/head-bucket`` and
``/tools/list-objects-v2``) are exercised through the API; the rest call the
s3-layer functions directly (their bespoke ``/tools/*`` wrappers were removed —
the agent and run executors call the same functions directly).
"""

import json
import sqlite3
from datetime import datetime, timezone
from io import BytesIO

import boto3
import pytest
from botocore.response import StreamingBody
from botocore.stub import Stubber

from app import config
from app.s3 import client_factory
from app.s3 import tools as s3
from app.tool_runner import run_tool

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
    conn = sqlite3.connect(str(config.db_path()))
    # Row factory so s3-layer helpers that read the provider row (load_provider
    # uses row["id"]) work when called directly, not only via the HTTP layer.
    # sqlite3.Row still supports integer indexing, so existing r[0] uses hold.
    conn.row_factory = sqlite3.Row
    return conn


# --- test_credentials -------------------------------------------------------


def test_credentials_success(client, cloud_id, stub):
    _, s = stub
    s.add_response("list_buckets", {"Buckets": [{"Name": "b1"}], "Owner": {"DisplayName": "acct"}})
    with _db() as conn:
        body = s3.test_credentials(conn, cloud_id)
    assert body["success"] is True
    assert body["identity_hint"] == "acct"
    assert body["provider_type"] == "s3-compatible"
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in json.dumps(body)


def test_credentials_unsupported_is_not_hard_failure(client, cloud_id, stub):
    _, s = stub
    s.add_client_error("list_buckets", service_error_code="NotImplemented", http_status_code=501)
    with _db() as conn:
        body = s3.test_credentials(conn, cloud_id)
    assert body["success"] is True
    assert body["identity_hint"] == "Provider unsupported"


def test_credentials_auth_failure(client, cloud_id, stub):
    _, s = stub
    s.add_client_error("list_buckets", service_error_code="InvalidAccessKeyId", http_status_code=403)
    with _db() as conn:
        body = s3.test_credentials(conn, cloud_id)
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


# --- legacy /tools/* surface shrunk to the two used endpoints (fix 15) -------


def test_removed_tools_endpoints_are_gone(client, cloud_id):
    """Only /tools/head-bucket and /tools/list-objects-v2 survive; the former
    per-tool HTTP wrappers were deleted (their s3-layer fns are called directly
    by the agent/executors)."""
    for path in ("/tools/test-credentials", "/tools/head-object", "/tools/test-range-get",
                 "/tools/test-path-style-vs-virtual-host", "/tools/inspect-tls",
                 "/tools/get-bucket-config-summary", "/tools/review-bucket-security"):
        resp = client.post(path, json={"provider_id": cloud_id, "bucket": BUCKET,
                                        "endpoint_url": "https://x", "key": "k",
                                        "range_header": "bytes=0-1"})
        assert resp.status_code == 404, path


# --- provider bucket/prefix scope enforcement (fix 11) -----------------------


def test_head_bucket_denies_out_of_scope_bucket(client, monkeypatch):
    """A provider restricted to allowed_buckets rejects an out-of-scope bucket
    at the surviving HTTP surface (scope isn't only enforced inside the agent)."""
    pid = client.post("/cloud-providers", json={
        "name": "scoped", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": ACCESS, "secret_key": SECRET,
        "allowed_buckets": ["only-this-one"],
    }).json()["id"]
    r = client.post("/tools/head-bucket", json={"provider_id": pid, "bucket": BUCKET})
    assert r.status_code == 403
    assert "scope" in r.json()["detail"].lower()


def test_list_objects_denies_out_of_scope_prefix(client, monkeypatch):
    pid = client.post("/cloud-providers", json={
        "name": "scoped2", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": ACCESS, "secret_key": SECRET,
        "allowed_prefixes": ["logs/"],
    }).json()["id"]
    r = client.post("/tools/list-objects-v2",
                    json={"provider_id": pid, "bucket": BUCKET, "max_keys": 10, "prefix": "secret/"})
    assert r.status_code == 403


def test_check_scope_unit():
    from app.s3.scope import check_scope

    # Unrestricted (empty lists) → always allowed.
    assert check_scope([], [], "any-bucket", prefix="x/") is None
    # Bucket not in allowed_buckets → denied.
    assert check_scope(["a"], [], "b") is not None
    # Bucket allowed, no prefix restriction → allowed.
    assert check_scope(["a"], [], "a", prefix="anything/") is None
    # Prefix restriction: object key must match; bucket-level (no key/prefix) ok.
    assert check_scope([], ["logs/"], "a") is None
    assert check_scope([], ["logs/"], "a", key="logs/f") is None
    assert check_scope([], ["logs/"], "a", key="data/f") is not None


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
        "success": True, "key_count": 700, "keys": [f"k{i}" for i in range(700)],
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
    assert out["key_count"] == 700            # exact count preserved
    assert len(out["keys"]) == 500            # capped for context (_LIST_KEYS_CTX_CAP)
    assert out["keys_truncated_in_context"] is True
    assert out["next_token"] == "T"           # can still page


def test_session_tools_register_new_diagnostics(client):
    """The two new diagnostics are wired into the read-only investigator tool set.

    Requests the ``client`` fixture so the temp data dir + DB exist regardless of
    test ordering (``_db()`` opens ``config.db_path()``); without it this test
    passed only when an earlier test happened to create the database first.
    """
    from app.agent_runtime import session_tools

    class _FT:
        def __call__(self, fn):
            fn.name = fn.__name__
            return fn

    with _db() as conn:
        conn.row_factory = sqlite3.Row
        names = {t.name for t in session_tools.build(conn, _FT(), [])}
    assert {"measure_request_latency", "get_object_lock_status"} <= names


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
    with _db() as conn:
        body = s3.head_object(conn, cloud_id, BUCKET, "a.txt")
    assert body["success"] is True
    assert body["size"] == 1024
    assert body["metadata_sanitized"]["team"] == "infra"
    assert body["metadata_sanitized"]["authorization"] == "***REDACTED***"
    assert "leaky-token" not in json.dumps(body)


# --- test_range_get ---------------------------------------------------------


def test_range_get_rejects_open_ended(client, cloud_id, stub):
    with _db() as conn:
        body = s3.test_range_get(conn, cloud_id, BUCKET, "a", "bytes=0-")
    assert body["success"] is False
    assert body["error_code"] == "RangeRequired"


def test_range_get_rejects_too_large(client, cloud_id, stub):
    with _db() as conn:
        body = s3.test_range_get(conn, cloud_id, BUCKET, "a", "bytes=0-5242880")
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
    with _db() as conn:
        body = s3.test_range_get(conn, cloud_id, BUCKET, "a", "bytes=0-9")
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
    with _db() as conn:
        body = s3.test_path_style_vs_virtual_host(conn, cloud_id, BUCKET)
    assert body["recommendation"] == "path"
    assert body["path_style_result"]["success"] is True
    assert body["virtual_hosted_result"]["success"] is False


# --- inspect_tls ------------------------------------------------------------


def test_inspect_tls_graceful_error_no_network(client):
    # Port 1 refuses fast; no DNS egress, no subprocess.
    body = s3.inspect_tls("https://127.0.0.1:1")
    assert body["tls_version"] is None
    assert body["error_message_sanitized"] is not None


def test_inspect_tls_redacts_presigned_query_in_recorded_input(client):
    # The shared redaction layer masks presigned query params in a recorded
    # tool input (run_tool sanitizes before persistence — defense in depth now
    # that the endpoint's own query-strip helper is gone).
    conn = _db()
    try:
        run_tool(
            conn, "inspect_tls",
            {"endpoint_url": "https://127.0.0.1:1/p?X-Amz-Signature=abc123&X-Amz-Credential=AKIA/cred"},
            lambda: s3.inspect_tls("https://127.0.0.1:1"),
        )
        row = conn.execute(
            "SELECT input_json_sanitized FROM tool_calls WHERE tool_name='inspect_tls'"
        ).fetchone()
    finally:
        conn.close()
    recorded = row[0]
    assert "abc123" not in recorded


# --- recording + no-leak ----------------------------------------------------


def test_tool_calls_and_audit_recorded_without_secrets(client, cloud_id, stub):
    _, s = stub
    s.add_response("list_buckets", {"Buckets": [], "Owner": {"DisplayName": "acct"}})
    conn0 = _db()
    try:
        run_tool(conn0, "test_credentials", {"provider_id": cloud_id},
                 lambda: s3.test_credentials(conn0, cloud_id))
    finally:
        conn0.close()

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


# --- preview_object (bounded, read-only content preview) --------------------


def test_preview_object_returns_sanitized_text(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    body = b"config: ok\nsecret_key=AKIAIOSFODNN7EXAMPLE\n"
    s.add_response(
        "get_object",
        {"Body": StreamingBody(BytesIO(body), len(body)), "ContentType": "text/plain",
         "ContentRange": f"bytes 0-{len(body) - 1}/{len(body)}"},
        expected_params={"Bucket": BUCKET, "Key": "cfg.txt", "Range": "bytes=0-262143"},
    )
    with _db() as conn:
        res = s3.preview_object(conn, cloud_id, BUCKET, "cfg.txt", 262144)
    assert res["success"] is True and res["binary"] is False
    assert "config: ok" in res["content"]
    assert "AKIAIOSFODNN7EXAMPLE" not in res["content"]  # redacted
    assert res["object_size"] == len(body)


def test_preview_object_csv_structure_hint(client, cloud_id, stub):
    """A CSV preview carries a `structure` summary (columns) read from the same
    preview bytes — no extra fetch — while still returning the raw text."""
    from app.s3 import tools as s3

    c, s = stub
    body = b"name,region,size\nobj1,us-east-1,42\nobj2,eu-west-1,99\n"
    s.add_response(
        "get_object",
        {"Body": StreamingBody(BytesIO(body), len(body)), "ContentType": "text/csv",
         "ContentRange": f"bytes 0-{len(body) - 1}/{len(body)}"},
        expected_params={"Bucket": BUCKET, "Key": "inv.csv", "Range": "bytes=0-262143"},
    )
    with _db() as conn:
        res = s3.preview_object(conn, cloud_id, BUCKET, "inv.csv", 262144)
    assert res["success"] is True
    st = res.get("structure")
    assert st and st["format"] == "csv"
    assert st["columns"] == ["name", "region", "size"]
    assert st["column_count"] == 3 and st["sampled_rows"] == 2
    assert "obj1" in res["content"]  # raw text still returned


def test_preview_object_json_structure_hint(client, cloud_id, stub):
    """A JSON preview carries a `structure` summary (top-level keys)."""
    from app.s3 import tools as s3

    c, s = stub
    body = b'{"versioning": "Enabled", "encryption": "aws:kms", "rules": []}'
    s.add_response(
        "get_object",
        {"Body": StreamingBody(BytesIO(body), len(body)), "ContentType": "application/json",
         "ContentRange": f"bytes 0-{len(body) - 1}/{len(body)}"},
        expected_params={"Bucket": BUCKET, "Key": "cfg.json", "Range": "bytes=0-262143"},
    )
    with _db() as conn:
        res = s3.preview_object(conn, cloud_id, BUCKET, "cfg.json", 262144)
    assert res["success"] is True
    st = res.get("structure")
    assert st and st["format"] == "json" and st["root"] == "object"
    assert set(st["keys"]) == {"versioning", "encryption", "rules"}


def test_preview_object_rejects_binary(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    body = b"\x89PNG\r\n\x00\x00binary-bytes"
    s.add_response(
        "get_object",
        {"Body": StreamingBody(BytesIO(body), len(body)), "ContentType": "image/png"},
        expected_params={"Bucket": BUCKET, "Key": "img.png", "Range": "bytes=0-262143"},
    )
    with _db() as conn:
        res = s3.preview_object(conn, cloud_id, BUCKET, "img.png", 262144)
    assert res["success"] is True and res["binary"] is True and res["content"] is None


def test_preview_object_zero_byte_object_is_empty_not_error(client, cloud_id, stub):
    """A Range GET on a zero-byte object returns 416 InvalidRange — that's an
    empty object, not a failure (review L-5)."""
    from app.s3 import tools as s3

    c, s = stub
    s.add_client_error("get_object", service_error_code="InvalidRange", http_status_code=416)
    with _db() as conn:
        res = s3.preview_object(conn, cloud_id, BUCKET, "empty.txt", 262144)
    assert res["success"] is True
    assert res["content"] == "" and res["bytes_read"] == 0 and res["object_size"] == 0


def test_preview_object_gzip_is_decompressed_within_bound(client, cloud_id, stub):
    """A .gz log is decompressed (bounded) instead of dead-ending at 'binary' (B2)."""
    import gzip as _gzip

    from app.s3 import tools as s3

    plain = b"GET /a 200\nGET /b 404\n" * 20
    gz = _gzip.compress(plain)
    c, s = stub
    s.add_response(
        "get_object",
        {"Body": StreamingBody(BytesIO(gz), len(gz)), "ContentType": "application/gzip",
         "ContentRange": f"bytes 0-{len(gz) - 1}/{len(gz)}"},
        expected_params={"Bucket": BUCKET, "Key": "app.log.gz", "Range": "bytes=0-262143"},
    )
    with _db() as conn:
        res = s3.preview_object(conn, cloud_id, BUCKET, "app.log.gz", 262144)
    assert res["success"] is True and res["binary"] is False
    assert res["decompressed"] is True
    assert "GET /a 200" in res["content"]


def test_preview_object_parquet_returns_schema_not_body(client, cloud_id, stub):
    """A .parquet object returns a footer/schema STRUCTURE preview, never the body (B2)."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    from app.s3 import tools as s3

    buf = BytesIO()
    table = pa.table({"key": ["a", "b", "c"], "size": [1, 2, 3]})
    pq.write_table(table, buf)
    blob = buf.getvalue()
    tail = blob[-len(blob):]  # whole file fits the cap here
    c, s = stub
    s.add_response(
        "get_object",
        {"Body": StreamingBody(BytesIO(tail), len(tail)), "ContentType": "application/octet-stream",
         "ContentRange": f"bytes 0-{len(blob) - 1}/{len(blob)}"},
        expected_params={"Bucket": BUCKET, "Key": "inv.parquet", "Range": "bytes=-262144"},
    )
    with _db() as conn:
        res = s3.preview_object(conn, cloud_id, BUCKET, "inv.parquet", 262144)
    assert res["success"] is True and res.get("parquet")
    assert res["parquet"]["num_rows"] == 3
    names = {c["name"] for c in res["parquet"]["columns"]}
    assert {"key", "size"} <= names
    assert res.get("content") is None  # no body text ever returned


def test_object_lock_status_invalid_request_means_no_lock(client, cloud_id, stub):
    """S3 returns InvalidRequest for get_object_retention on a bucket without
    Object Lock — treat it as 'none', not a confusing hard error (review L-4)."""
    from app.s3 import tools as s3

    c, s = stub
    s.add_client_error("get_object_retention", service_error_code="InvalidRequest")
    s.add_client_error("get_object_legal_hold", service_error_code="InvalidRequest")
    with _db() as conn:
        res = s3.get_object_lock_status(conn, cloud_id, BUCKET, "obj.bin")
    assert res["success"] is True
    assert res["retention_status"] == "none" and res["legal_hold_status"] == "none"
    assert res["error_code"] is None


def test_preview_object_clamps_request_to_hard_cap(client, cloud_id, stub):
    """A max_bytes above the 1 MiB hard cap is clamped in the Range header."""
    from app.s3 import tools as s3

    c, s = stub
    body = b"x" * 100
    s.add_response(
        "get_object",
        {"Body": StreamingBody(BytesIO(body), len(body)), "ContentType": "text/plain"},
        expected_params={"Bucket": BUCKET, "Key": "big.txt", "Range": f"bytes=0-{s3.PREVIEW_MAX_BYTES - 1}"},
    )
    with _db() as conn:
        res = s3.preview_object(conn, cloud_id, BUCKET, "big.txt", 999_999_999)
    assert res["success"] is True  # StubAssertionError would fire if Range wasn't clamped


def test_preview_object_per_turn_budget(client, cloud_id, monkeypatch):
    """preview_object reads content, so it's bounded per turn — a few objects,
    then the budget is exhausted (can't be looped into a bulk download)."""
    import json as _json

    from app.agent_runtime import session_tools
    from app.s3 import tools as s3mod

    monkeypatch.setattr(s3mod, "preview_object",
                        lambda *a, **k: {"success": True, "content": "x", "bytes_read": 10, "binary": False})

    class _FT:
        def __call__(self, fn):
            fn.name = fn.__name__
            return fn

    with _db() as conn:
        conn.row_factory = sqlite3.Row
        tools = {t.name: t for t in session_tools.build(conn, _FT(), [])}
        pv = tools["preview_object"]
        results = [_json.loads(pv(cloud_id, BUCKET, f"k{i}.txt")) for i in range(17)]
    assert all("error" not in r for r in results[:16])          # first 16 succeed (_MAX_PREVIEWS)
    assert "error" in results[16] and "budget" in results[16]["error"].lower()  # 17th blocked


# --- list_object_versions / list_multipart_uploads (data-level, read-only) --


def test_list_object_versions_counts_pileup(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    s.add_response(
        "list_object_versions",
        {"Versions": [
            {"Key": "a", "IsLatest": True, "Size": 100},
            {"Key": "a", "IsLatest": False, "Size": 90},
            {"Key": "a", "IsLatest": False, "Size": 80},
         ],
         "DeleteMarkers": [{"Key": "b", "IsLatest": True}],
         "IsTruncated": False},
        expected_params={"Bucket": BUCKET, "Prefix": "", "MaxKeys": 1000},
    )
    with _db() as conn:
        res = s3.list_object_versions(conn, cloud_id, BUCKET, None, 1000)
    assert res["success"] is True
    assert res["version_count"] == 3
    assert res["noncurrent_version_count"] == 2
    assert res["delete_marker_count"] == 1
    assert res["current_bytes"] == 100 and res["noncurrent_bytes"] == 170


def test_list_object_versions_caps_sample_keys(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    s.add_response(
        "list_object_versions",
        {"Versions": [{"Key": f"k{i}", "IsLatest": True, "Size": 1} for i in range(50)],
         "IsTruncated": True, "NextKeyMarker": "k49"},
        expected_params={"Bucket": BUCKET, "Prefix": "", "MaxKeys": 1000},
    )
    with _db() as conn:
        res = s3.list_object_versions(conn, cloud_id, BUCKET, None, 1000)
    assert len(res["sample_keys"]) <= 20  # rule 16: ≤20 sample keys
    assert res["is_truncated"] is True and res["next_key_marker"] == "k49"


def test_list_multipart_uploads_reports_abandoned(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    s.add_response(
        "list_multipart_uploads",
        {"Uploads": [
            {"Key": "big.bin", "Initiated": datetime(2026, 1, 1, tzinfo=timezone.utc)},
            {"Key": "big2.bin", "Initiated": datetime(2026, 6, 1, tzinfo=timezone.utc)},
         ], "IsTruncated": False},
        expected_params={"Bucket": BUCKET, "MaxUploads": 1000},
    )
    with _db() as conn:
        res = s3.list_multipart_uploads(conn, cloud_id, BUCKET, 1000)
    assert res["success"] is True and res["upload_count"] == 2
    assert res["oldest_initiated"].startswith("2026-01-01")  # earliest


def test_list_object_versions_provider_unsupported(client, cloud_id, stub):
    """A provider that doesn't implement ListObjectVersions surfaces as a clean
    error, not a crash (rule 18)."""
    from app.s3 import tools as s3

    c, s = stub
    s.add_client_error("list_object_versions", service_error_code="NotImplemented",
                       http_status_code=501)
    with _db() as conn:
        res = s3.list_object_versions(conn, cloud_id, BUCKET, None, 1000)
    assert res["success"] is False and res["error_code"] == "NotImplemented"


# --- measure_request_latency (live probe, read-only, bounded) ---------------


def test_measure_request_latency_head_bucket(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    for _ in range(3):
        s.add_response("head_bucket", {}, expected_params={"Bucket": BUCKET})
    with _db() as conn:
        res = s3.measure_request_latency(conn, cloud_id, BUCKET, None, 3)
    assert res["success"] is True and res["operation"] == "head_bucket"
    assert res["samples_ok"] == 3 and res["samples_failed"] == 0
    # Stats are present and ordered.
    for k in ("min_ms", "p50_ms", "p95_ms", "max_ms", "mean_ms"):
        assert isinstance(res[k], (int, float))
    assert res["min_ms"] <= res["p50_ms"] <= res["max_ms"]


def test_measure_request_latency_uses_head_object_for_key(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    for _ in range(2):
        s.add_response("head_object", {"ContentLength": 10},
                       expected_params={"Bucket": BUCKET, "Key": "some/key"})
    with _db() as conn:
        res = s3.measure_request_latency(conn, cloud_id, BUCKET, "some/key", 2)
    assert res["success"] is True and res["operation"] == "head_object"
    assert res["samples_ok"] == 2


def test_measure_request_latency_clamps_samples(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    for _ in range(s3.LATENCY_MAX_SAMPLES):  # only the capped count of round-trips is made
        s.add_response("head_bucket", {}, expected_params={"Bucket": BUCKET})
    with _db() as conn:
        res = s3.measure_request_latency(conn, cloud_id, BUCKET, None, 100)
    assert res["samples_requested"] == s3.LATENCY_MAX_SAMPLES
    assert res["samples_ok"] == s3.LATENCY_MAX_SAMPLES


def test_measure_request_latency_all_fail_surfaces_error(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    for _ in range(2):
        s.add_client_error("head_bucket", service_error_code="AccessDenied",
                           http_status_code=403)
    with _db() as conn:
        res = s3.measure_request_latency(conn, cloud_id, BUCKET, None, 2)
    assert res["success"] is False
    assert res["samples_failed"] == 2 and res["error_code"] == "AccessDenied"


# --- get_object_lock_status (object-level retention + legal hold) -----------


def test_get_object_lock_status_active(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    until = datetime(2030, 1, 1, tzinfo=timezone.utc)
    s.add_response("get_object_retention",
                   {"Retention": {"Mode": "COMPLIANCE", "RetainUntilDate": until}},
                   expected_params={"Bucket": BUCKET, "Key": "locked"})
    s.add_response("get_object_legal_hold", {"LegalHold": {"Status": "ON"}},
                   expected_params={"Bucket": BUCKET, "Key": "locked"})
    with _db() as conn:
        res = s3.get_object_lock_status(conn, cloud_id, BUCKET, "locked")
    assert res["success"] is True
    assert res["retention_mode"] == "COMPLIANCE" and res["retention_status"] == "active"
    assert res["retain_until_date"].startswith("2030-01-01")
    assert res["legal_hold_status"] == "on"


def test_get_object_lock_status_none_is_normal(client, cloud_id, stub):
    """No lock configured on the object is a valid answer, not a hard failure."""
    from app.s3 import tools as s3

    c, s = stub
    s.add_client_error("get_object_retention",
                       service_error_code="NoSuchObjectLockConfiguration",
                       http_status_code=404)
    s.add_client_error("get_object_legal_hold",
                       service_error_code="NoSuchObjectLockConfiguration",
                       http_status_code=404)
    with _db() as conn:
        res = s3.get_object_lock_status(conn, cloud_id, BUCKET, "plain")
    assert res["success"] is True
    assert res["retention_status"] == "none" and res["legal_hold_status"] == "none"


def test_get_object_lock_status_provider_unsupported(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    s.add_client_error("get_object_retention", service_error_code="NotImplemented",
                       http_status_code=501)
    s.add_client_error("get_object_legal_hold", service_error_code="NotImplemented",
                       http_status_code=501)
    with _db() as conn:
        res = s3.get_object_lock_status(conn, cloud_id, BUCKET, "k")
    assert res["success"] is True
    assert res["retention_status"] == "provider_unsupported"
    assert res["legal_hold_status"] == "provider_unsupported"


def test_get_object_lock_status_access_denied_is_hard_error(client, cloud_id, stub):
    from app.s3 import tools as s3

    c, s = stub
    s.add_client_error("get_object_retention", service_error_code="AccessDenied",
                       http_status_code=403)
    s.add_client_error("get_object_legal_hold", service_error_code="AccessDenied",
                       http_status_code=403)
    with _db() as conn:
        res = s3.get_object_lock_status(conn, cloud_id, BUCKET, "k")
    assert res["success"] is False and res["error_code"] == "AccessDenied"


# --- get_object_acl (object-level grants, no id/email leak) ------------------

_PUBLIC_URI = "http://acs.amazonaws.com/groups/global/AllUsers"


def test_get_object_acl_flags_public_without_leaking_identity(client, cloud_id, stub):
    from app.s3 import tools as s3

    _, s = stub
    s.add_response("get_object_acl", {
        "Owner": {"ID": "canonical-owner-id-123", "DisplayName": "acct-owner"},
        "Grants": [
            {"Grantee": {"Type": "CanonicalUser", "ID": "canonical-owner-id-123",
                         "DisplayName": "acct-owner"}, "Permission": "FULL_CONTROL"},
            {"Grantee": {"Type": "Group", "URI": _PUBLIC_URI}, "Permission": "READ"},
        ],
    }, expected_params={"Bucket": BUCKET, "Key": "pub"})
    with _db() as conn:
        res = s3.get_object_acl(conn, cloud_id, BUCKET, "pub")
    assert res["success"] is True and res["is_public"] is True
    assert res["public_permissions"] == ["READ"]
    assert {g["grantee_kind"] for g in res["grants"]} == {"canonical-user", "public-all-users"}
    assert res["owner_display"] == "present"
    # No canonical id / display name leaks anywhere.
    blob = json.dumps(res)
    assert "canonical-owner-id-123" not in blob and "acct-owner" not in blob


def test_get_object_acl_private_is_not_public(client, cloud_id, stub):
    from app.s3 import tools as s3

    _, s = stub
    s.add_response("get_object_acl", {
        "Owner": {"ID": "id"},
        "Grants": [{"Grantee": {"Type": "CanonicalUser", "ID": "id"}, "Permission": "FULL_CONTROL"}],
    }, expected_params={"Bucket": BUCKET, "Key": "priv"})
    with _db() as conn:
        res = s3.get_object_acl(conn, cloud_id, BUCKET, "priv")
    assert res["success"] is True and res["is_public"] is False
    assert res["public_permissions"] == []


def test_get_object_acl_provider_unsupported(client, cloud_id, stub):
    from app.s3 import tools as s3

    _, s = stub
    s.add_client_error("get_object_acl", service_error_code="NotImplemented", http_status_code=501)
    with _db() as conn:
        res = s3.get_object_acl(conn, cloud_id, BUCKET, "k")
    assert res["success"] is True and res["acl_status"] == "provider_unsupported"


# --- get_object_tagging (redacted keys + values) ----------------------------


def test_get_object_tagging_redacts_and_counts(client, cloud_id, stub):
    from app.s3 import tools as s3

    _, s = stub
    s.add_response("get_object_tagging", {"TagSet": [
        {"Key": "env", "Value": "prod"}, {"Key": "owner", "Value": "team-a"}]},
        expected_params={"Bucket": BUCKET, "Key": "obj"})
    with _db() as conn:
        res = s3.get_object_tagging(conn, cloud_id, BUCKET, "obj")
    assert res["success"] is True and res["tag_count"] == 2
    assert res["tags"]["env"] == "prod" and res["tags"]["owner"] == "team-a"


def test_get_object_tagging_empty_is_normal(client, cloud_id, stub):
    from app.s3 import tools as s3

    _, s = stub
    s.add_response("get_object_tagging", {"TagSet": []},
                   expected_params={"Bucket": BUCKET, "Key": "obj"})
    with _db() as conn:
        res = s3.get_object_tagging(conn, cloud_id, BUCKET, "obj")
    assert res["success"] is True and res["tag_count"] == 0 and res["tags"] == {}


# --- get_object_attributes (checksum / parts / storage-class / size) --------


def test_get_object_attributes_surfaces_parts_and_checksum(client, cloud_id, stub):
    from app.s3 import tools as s3

    _, s = stub
    s.add_response("get_object_attributes", {
        "ETag": "abc123", "StorageClass": "GLACIER", "ObjectSize": 1048576,
        "Checksum": {"ChecksumSHA256": "deadbeef"},
        "ObjectParts": {"TotalPartsCount": 4},
    }, expected_params={
        "Bucket": BUCKET, "Key": "big",
        "ObjectAttributes": ["ETag", "Checksum", "ObjectParts", "StorageClass", "ObjectSize"]})
    with _db() as conn:
        res = s3.get_object_attributes(conn, cloud_id, BUCKET, "big")
    assert res["success"] is True and res["storage_class"] == "GLACIER"
    assert res["size"] == 1048576 and res["parts_count"] == 4
    assert res["checksum_algorithm"] == "SHA256"


def test_get_object_attributes_provider_unsupported(client, cloud_id, stub):
    from app.s3 import tools as s3

    _, s = stub
    s.add_client_error("get_object_attributes", service_error_code="MethodNotAllowed",
                       http_status_code=405)
    with _db() as conn:
        res = s3.get_object_attributes(conn, cloud_id, BUCKET, "k")
    assert res["success"] is True and res["attributes_status"] == "provider_unsupported"
