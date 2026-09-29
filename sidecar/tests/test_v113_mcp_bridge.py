"""The read-only MCP server (official SDK, opt-in) exposes the registry's
stateless read-only subset with the same scope check, audited as actor=mcp."""

from __future__ import annotations

import asyncio
import json

from app.agent import tools as _tools  # noqa: F401
from app.api import mcp


def test_off_by_default():
    assert mcp.ENABLED is False and mcp.SERVER is None


def test_exposes_only_stateless_read_only_tools():
    names = mcp.exposed()
    assert {"list_buckets", "inspect_object", "review_bucket_config", "get_bucket_config_detail"} <= names
    for task_bound in ("survey_account", "import_evidence", "record_conclusion", "list_uploaded_files",
                       "analyze_uploaded_file", "simulate_storage_cost", "note", "fix_preview"):
        assert task_bound not in names
    server = mcp.build_server()
    listed = {t.name: t for t in asyncio.run(server.list_tools())}
    assert set(listed) == names | {"list_providers"}
    assert all(t.annotations and t.annotations.read_only_hint for t in listed.values())


def test_call_is_scope_checked_and_audited(client, conn):
    pid = client.post("/providers/clouds", json={
        "name": "scoped", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "allowed_buckets": ["only-this"]}).json()["id"]
    server = mcp.build_server()
    result = asyncio.run(server.call_tool("head_bucket", {"provider_id": pid, "bucket": "elsewhere"}))
    text = json.dumps(result.model_dump(), default=str)
    assert "Refused" in text
    row = conn.execute("SELECT actor, action, ok FROM audit WHERE action = 'tool.head_bucket'").fetchone()
    assert (row["actor"], row["ok"]) == ("mcp", 0)
    providers = asyncio.run(server.call_tool("list_providers", {}))
    blob = json.dumps(providers.model_dump(), default=str)
    assert pid in blob and "wJalrXUtnFEMI" not in blob and "AKIA" not in blob
