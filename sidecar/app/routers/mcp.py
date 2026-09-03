"""MCP bridge router — opt-in read-only exposure of existing tools.

Disabled by default (STORAGE_AGENT_ENABLE_MCP != "1" → every route 404).
When enabled, the desktop app and any local MCP client can:
  GET  /mcp/tools        — list the whitelisted read-only tools as MCP definitions
  POST /mcp/tools/call   — call one whitelisted tool with same bounds/redaction
  GET  /mcp/status       — whether MCP is enabled and which tools are exposed

Security: same provider scope enforcement, same redaction, same per-call caps
as the in-process agent tools (every call is recorded through ``run_tool``,
which writes a sanitized ``tool_calls`` + audit row). No shell, no raw boto3,
no filesystem escape. v1.13 executes through the S3 layer directly — the
pre-v1.13 validated-echo stub is gone.

Scope note: the bridge is STATELESS by design, so the four session-bound tools
(``survey_account``, ``query_account_profile``, ``compare_to_last_survey``,
``list_uploaded_files``) are NOT exposed here — they need a task's runs and
profiles to answer. They remain available to the Agent itself inside a Task.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..db import get_conn

router = APIRouter(prefix="/mcp", tags=["mcp"])

_ENABLED = os.environ.get("STORAGE_AGENT_ENABLE_MCP") == "1"

# Whitelisted read-only tools exposed via MCP. Stateless S3/config reads plus
# first-party skill text and the price-table status — no evidence-import
# plan/confirm, no dataset upload, no session-bound survey/profile tools (see
# module docstring). The allowlist is the source of truth.
_MCP_TOOL_ALLOWLIST: frozenset[str] = frozenset({
    "list_providers", "list_buckets", "test_credentials", "head_bucket",
    "get_bucket_location", "list_objects", "head_object", "get_object_attributes",
    "get_object_lock_status", "get_object_acl", "get_object_tagging",
    "list_object_versions", "list_multipart_uploads", "list_upload_parts",
    "test_range_get", "test_conditional_get", "preview_object",
    "measure_request_latency", "diagnose_presigned_url", "test_addressing_style",
    "inspect_endpoint_tls", "get_bucket_config_summary", "get_bucket_config_detail",
    "review_bucket_security", "review_bucket_lifecycle", "review_bucket_observability",
    "review_bucket_cost_optimization", "review_bucket_performance_profile",
    "read_skill", "get_price_table_status",
})

# Tools that need no provider_id (pure parsing, local config, first-party text).
_PROVIDERLESS = frozenset({
    "diagnose_presigned_url", "read_skill", "get_price_table_status",
    "list_providers",
})

# Per-call input clamps (mirror the agent-side budgets; the S3 layer holds the
# hard caps — these keep an MCP caller from even asking for more).
_MAX_LIST_KEYS = 1000
_MAX_LATENCY_SAMPLES = 10
_MAX_PREVIEW_BYTES = 1 * 1024 * 1024


class McpCallRequest(BaseModel):
    tool: str = Field(min_length=1)
    arguments: dict = Field(default_factory=dict)
    provider_id: str | None = None


def _require_enabled():
    if not _ENABLED and os.environ.get("STORAGE_AGENT_ENABLE_MCP") != "1":
        # Re-read env each request so tests can flip it without import reload.
        if os.environ.get("STORAGE_AGENT_ENABLE_MCP") != "1":
            raise HTTPException(status_code=404, detail="MCP bridge is disabled. Set STORAGE_AGENT_ENABLE_MCP=1 to enable (read-only).")


def _str(args: dict, *keys: str, default: str = "") -> str:
    for k in keys:
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return default


def _int(args: dict, key: str, default: int) -> int:
    try:
        return int(args.get(key, default))
    except (TypeError, ValueError):
        return default


def _dispatch(conn: sqlite3.Connection, tool: str, args: dict,
              provider_id: str | None) -> dict[str, Any]:
    """Run one allowlisted tool through the same S3 layer the Agent uses."""
    from ..repositories import cloud_providers as cloud_repo
    from ..s3 import tools as s3
    from ..s3 import config_tools
    from ..s3.scope import check_scope

    if tool not in _PROVIDERLESS and not provider_id:
        return {"success": False, "error_code": "missing_provider_id",
                "error_message_sanitized": "provider_id is required for this tool"}
    provider = cloud_repo.get(conn, provider_id) if provider_id else None

    def _scope(bucket: str, *, key: str | None = None,
               prefix: str | None = None, listing: bool = False) -> dict[str, Any] | None:
        if provider is None:
            return None  # unknown provider surfaces as a tool error downstream
        denial = check_scope(provider.allowed_buckets, provider.allowed_prefixes,
                             bucket, key=key, prefix=prefix, listing=listing)
        if denial:
            return {"success": False, "error_code": "scope_denied",
                    "error_message_sanitized": denial}
        return None

    bucket = _str(args, "bucket", "bucket_name")

    if tool == "list_providers":
        rows = cloud_repo.list_all(conn)
        return {"success": True, "providers": [
            {"provider_id": p.id, "name": p.name, "provider_type": p.provider_type}
            for p in rows]}
    if tool == "diagnose_presigned_url":
        url = _str(args, "url", "presigned_url")
        if not url:
            return {"success": False, "error_code": "missing_url",
                    "error_message_sanitized": "url is required"}
        return s3.diagnose_presigned_url(url)
    if tool == "read_skill":
        from ..skills import context as skill_context
        name = _str(args, "name", "skill")
        text = skill_context.read_skill_text(name) if name else None
        if not text:
            return {"success": False, "error_code": "unknown_skill",
                    "error_message_sanitized": f"unknown skill: {name[:80]}"}
        return {"success": True, "name": name, "method": text}
    if tool == "get_price_table_status":
        from ..analysis import prices
        doc = prices.load(conn)
        return {"success": True, "confirmed": doc["confirmed"],
                "example": doc["example"], "note": doc["note"],
                "updated_at": doc["updated_at"],
                "classes": sorted((doc.get("rates") or {}).get("storage_gb_month", {}))}
    if tool == "inspect_endpoint_tls":
        endpoint = (provider.endpoint_url if provider else None) or _str(args, "endpoint_url", "endpoint")
        if not endpoint:
            return {"success": False, "error_code": "no_endpoint",
                    "error_message_sanitized": "this provider has no custom endpoint_url to inspect"}
        return s3.inspect_tls(endpoint)

    # Everything below needs a provider + a bucket.
    assert provider_id is not None
    if not bucket:
        return {"success": False, "error_code": "missing_bucket",
                "error_message_sanitized": "bucket is required for this tool"}
    key = _str(args, "key") or None
    prefix = _str(args, "prefix") or None
    listing = tool in ("list_objects", "list_object_versions", "list_multipart_uploads")
    denied = _scope(bucket, key=key, prefix=prefix, listing=listing)
    if denied:
        return denied

    if tool == "list_buckets":
        return s3.list_buckets(conn, provider_id)
    if tool == "test_credentials":
        return s3.test_credentials(conn, provider_id)
    if tool == "head_bucket":
        return s3.head_bucket(conn, provider_id, bucket)
    if tool == "get_bucket_location":
        return s3.get_bucket_location(conn, provider_id, bucket)
    if tool == "list_objects":
        return s3.list_objects_v2(
            conn, provider_id, bucket,
            max(1, min(_int(args, "max_keys", 200), _MAX_LIST_KEYS)),
            prefix, _str(args, "continuation_token") or None)
    if tool == "head_object":
        return s3.head_object(conn, provider_id, bucket, key or "",
                              _str(args, "version_id") or None)
    if tool == "get_object_attributes":
        return s3.get_object_attributes(conn, provider_id, bucket, key or "",
                                        _str(args, "version_id") or None)
    if tool == "get_object_lock_status":
        return s3.get_object_lock_status(conn, provider_id, bucket, key or "",
                                         _str(args, "version_id") or None)
    if tool == "get_object_acl":
        return s3.get_object_acl(conn, provider_id, bucket, key or "",
                                 _str(args, "version_id") or None)
    if tool == "get_object_tagging":
        return s3.get_object_tagging(conn, provider_id, bucket, key or "",
                                     _str(args, "version_id") or None)
    if tool == "list_object_versions":
        return s3.list_object_versions(
            conn, provider_id, bucket, prefix,
            max(1, min(_int(args, "max_keys", 1000), _MAX_LIST_KEYS)),
            _str(args, "key_marker") or None, _str(args, "version_id_marker") or None)
    if tool == "list_multipart_uploads":
        return s3.list_multipart_uploads(
            conn, provider_id, bucket,
            max(1, min(_int(args, "max_uploads", 1000), _MAX_LIST_KEYS)),
            prefix, _str(args, "key_marker") or None,
            _str(args, "upload_id_marker") or None)
    if tool == "list_upload_parts":
        upload_id = _str(args, "upload_id")
        if not upload_id:
            return {"success": False, "error_code": "missing_upload_id",
                    "error_message_sanitized": "upload_id is required"}
        return s3.list_upload_parts(
            conn, provider_id, bucket, key or "", upload_id,
            max(1, min(_int(args, "max_parts", 1000), _MAX_LIST_KEYS)))
    if tool == "test_range_get":
        return s3.test_range_get(conn, provider_id, bucket, key or "",
                                 _str(args, "range_header") or "bytes=0-1023")
    if tool == "test_conditional_get":
        etag = _str(args, "etag")
        if not etag:
            return {"success": False, "error_code": "missing_etag",
                    "error_message_sanitized": "etag is required"}
        return s3.test_conditional_get(conn, provider_id, bucket, key or "", etag)
    if tool == "preview_object":
        return s3.preview_object(conn, provider_id, bucket, key or "",
                                 max(1, min(_int(args, "max_bytes", 262144),
                                            _MAX_PREVIEW_BYTES)))
    if tool == "measure_request_latency":
        return s3.measure_request_latency(
            conn, provider_id, bucket, key,
            max(1, min(_int(args, "samples", 5), _MAX_LATENCY_SAMPLES)))
    if tool == "test_addressing_style":
        return s3.test_path_style_vs_virtual_host(conn, provider_id, bucket)
    if tool == "get_bucket_config_summary":
        return config_tools.get_bucket_config_summary(conn, provider_id, bucket)
    if tool == "get_bucket_config_detail":
        aspect = _str(args, "aspect")
        if not aspect:
            return {"success": False, "error_code": "missing_aspect",
                    "error_message_sanitized": "aspect is required"}
        return config_tools.get_bucket_config_detail(conn, provider_id, bucket, aspect)
    if tool == "review_bucket_security":
        return config_tools.review_bucket_security(conn, provider_id, bucket)
    if tool == "review_bucket_lifecycle":
        return config_tools.review_bucket_lifecycle(conn, provider_id, bucket)
    if tool == "review_bucket_observability":
        return config_tools.review_bucket_observability(conn, provider_id, bucket)
    if tool == "review_bucket_cost_optimization":
        return config_tools.review_bucket_cost_optimization(conn, provider_id, bucket)
    if tool == "review_bucket_performance_profile":
        return config_tools.review_bucket_performance_profile(conn, provider_id, bucket)
    return {"success": False, "error_code": "not_wired",  # pragma: no cover
            "error_message_sanitized": f"tool '{tool}' is allowlisted but has no dispatcher"}


@router.get("/client/status")
def mcp_client_status():
    """Consuming third-party MCP servers is NOT implemented in v1.13.

    The threat model lives in ``docs/security.md`` (appendix: MCP client).
    This endpoint exists so future work has a stable discovery shape — it
    reports disabled with the reason, never a fake accepted call."""
    return {
        "enabled": False,
        "reason": ("no MCP client in v1.13: consuming third-party tool servers "
                   "is a new trust boundary (server text is untrusted input, tool "
                   "schemas are attacker-controlled). See docs/security.md."),
        "design": "docs/security.md#mcp-client-threat-model",
    }


@router.get("/status")
def mcp_status():
    enabled = os.environ.get("STORAGE_AGENT_ENABLE_MCP") == "1"
    return {
        "enabled": enabled,
        "allowed_tools": sorted(_MCP_TOOL_ALLOWLIST) if enabled else [],
        "note": "MCP bridge is read-only and reuses the same tool bounds/redaction as the agent." if enabled else "Set STORAGE_AGENT_ENABLE_MCP=1 to enable the read-only MCP bridge.",
    }


@router.get("/tools")
def list_mcp_tools():
    _require_enabled()
    # Return MCP-style tool definitions (name + description). Descriptions are
    # intentionally short — the full schema lives in the agent runtime; this is
    # just discovery for a local MCP client.
    tools = []
    for name in sorted(_MCP_TOOL_ALLOWLIST):
        tools.append({
            "name": name,
            "description": f"Read-only storage tool: {name}. Bounded, sanitized, provider-scope enforced.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": True},
        })
    return {"tools": tools, "count": len(tools)}


@router.post("/tools/call")
def call_mcp_tool(
    body: McpCallRequest,
    conn: sqlite3.Connection = Depends(get_conn),
):
    """Execute one allowlisted read-only tool and return its sanitized result.

    v1.13 executes through the same S3 layer as the Agent (plus the provider
    scope check), recorded via ``run_tool`` so every MCP call leaves a
    sanitized ``tool_calls`` + audit row. Session-bound tools (surveys,
    profiles, uploads) are not exposed — the bridge is stateless.
    """
    _require_enabled()
    if body.tool not in _MCP_TOOL_ALLOWLIST:
        raise HTTPException(status_code=403, detail=f"tool '{body.tool}' is not exposed via MCP (allowlist only)")
    provider_id = body.provider_id or (body.arguments.get("provider_id")
                                       if isinstance(body.arguments.get("provider_id"), str) else None)
    from ..tool_runner import run_tool
    try:
        arg_keys = sorted(k for k in body.arguments.keys() if k != "provider_id")[:12]
    except Exception:  # noqa: BLE001 — defensive; arguments is a dict per schema
        arg_keys = []
    output = run_tool(
        conn, body.tool,
        {"provider_id": provider_id, "args": arg_keys, "via": "mcp"},
        lambda: _dispatch(conn, body.tool, body.arguments, provider_id),
    )
    return {"tool": body.tool, "status": "ok", "result": output,
            "provider_id": provider_id}
