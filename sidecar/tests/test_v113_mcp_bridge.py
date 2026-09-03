"""MCP bridge honesty (v1.13): real dispatch, real scope, no stubs.

``POST /mcp/tools/call`` executes through the same S3 layer as the Agent
(plus the provider scope check), recorded via ``run_tool``. Session-bound
tools are not exposed — the bridge is stateless. Disabled by default.
"""

from __future__ import annotations

import os

PRESIGNED_URL = ("https://bucket.s3.us-east-1.amazonaws.com/path/obj.bin"
                 "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
                 "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20200101%2Feu-west-1%2Fs3%2Faws4_request"
                 "&X-Amz-Date=20200101T000000Z&X-Amz-Expires=3600"
                 "&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeefcafe")


def _enable(monkeypatch):
    monkeypatch.setenv("STORAGE_AGENT_ENABLE_MCP", "1")


def _provider(client, **over):
    body = {"name": "mcp", "provider_type": "s3-compatible",
            "endpoint_url": "https://minio.example.com", "region": "us-east-1",
            "addressing_style": "path"}
    body.update(over)
    return client.post("/cloud-providers", json=body).json()["id"]


def test_mcp_disabled_by_default(client):
    os.environ.pop("STORAGE_AGENT_ENABLE_MCP", None)
    assert client.get("/mcp/tools").status_code == 404
    assert client.post("/mcp/tools/call",
                       json={"tool": "list_buckets", "arguments": {}}).status_code == 404


def test_mcp_allowlist_is_stateless_only(client, monkeypatch):
    _enable(monkeypatch)
    names = {t["name"] for t in client.get("/mcp/tools").json()["tools"]}
    for session_bound in ("survey_account", "query_account_profile",
                          "compare_to_last_survey", "list_uploaded_files"):
        assert session_bound not in names


def test_mcp_non_allowlisted_tool_is_403(client, monkeypatch):
    _enable(monkeypatch)
    r = client.post("/mcp/tools/call",
                    json={"tool": "import_evidence", "arguments": {}})
    assert r.status_code == 403


def test_mcp_presigned_parse_is_real_and_redacted(client, monkeypatch):
    _enable(monkeypatch)
    r = client.post("/mcp/tools/call", json={
        "tool": "diagnose_presigned_url", "arguments": {"url": PRESIGNED_URL}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    result = body["result"]
    assert result["success"] is True and result["signature_version"] == "v4"
    assert "deadbeefcafe" not in r.text and "AKIAIOSFODNN7EXAMPLE" not in r.text


def test_mcp_missing_provider_is_error_not_crash(client, monkeypatch):
    _enable(monkeypatch)
    r = client.post("/mcp/tools/call",
                    json={"tool": "head_bucket", "arguments": {"bucket": "b"}})
    assert r.status_code == 200
    assert r.json()["result"]["error_code"] == "missing_provider_id"


def test_mcp_scope_denial_matches_agent(client, monkeypatch):
    _enable(monkeypatch)
    pid = _provider(client, allowed_buckets=["logs"], allowed_prefixes=["app/"])
    r = client.post("/mcp/tools/call", json={
        "tool": "head_object",
        "arguments": {"bucket": "other", "key": "app/a"},
        "provider_id": pid})
    assert r.status_code == 200
    assert r.json()["result"]["error_code"] == "scope_denied"


def test_mcp_call_is_audited(client, monkeypatch):
    _enable(monkeypatch)
    from app import db
    client.post("/mcp/tools/call", json={
        "tool": "diagnose_presigned_url", "arguments": {"url": PRESIGNED_URL}})
    conn = db.connect()
    try:
        n = conn.execute(
            "SELECT count(*) FROM tool_calls WHERE tool_name = 'diagnose_presigned_url'"
        ).fetchone()[0]
    finally:
        conn.close()
    assert n >= 1
