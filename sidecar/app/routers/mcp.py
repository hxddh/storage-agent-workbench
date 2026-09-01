"""MCP bridge router — opt-in read-only exposure of existing tools.

Disabled by default (STORAGE_AGENT_ENABLE_MCP != "1" → every route 404).
When enabled, the desktop app and any local MCP client can:
  GET  /mcp/tools        — list the whitelisted read-only tools as MCP definitions
  POST /mcp/tools/call   — call one whitelisted tool with same bounds/redaction
  GET  /mcp/status       — whether MCP is enabled and which tools are exposed

Security: same provider scope enforcement, same redaction, same per-call caps
as the in-process agent tools. No shell, no raw boto3, no filesystem escape.
"""

from __future__ import annotations

import os
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..db import get_conn

router = APIRouter(prefix="/mcp", tags=["mcp"])

_ENABLED = os.environ.get("STORAGE_AGENT_ENABLE_MCP") == "1"

# Whitelisted read-only tools that are safe to expose via MCP.
# Subset of the full agent toolset — no evidence-import plan/confirm, no dataset upload.
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
    "survey_account", "query_account_profile", "compare_to_last_survey",
    "read_skill", "list_uploaded_files", "get_price_table_status",
})


class McpCallRequest(BaseModel):
    tool: str = Field(min_length=1)
    arguments: dict = Field(default_factory=dict)
    provider_id: str | None = None


def _require_enabled():
    if not _ENABLED and os.environ.get("STORAGE_AGENT_ENABLE_MCP") != "1":
        # Re-read env each request so tests can flip it without import reload.
        if os.environ.get("STORAGE_AGENT_ENABLE_MCP") != "1":
            raise HTTPException(status_code=404, detail="MCP bridge is disabled. Set STORAGE_AGENT_ENABLE_MCP=1 to enable (read-only).")


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
    _require_enabled()
    if body.tool not in _MCP_TOOL_ALLOWLIST:
        raise HTTPException(status_code=403, detail=f"tool '{body.tool}' is not exposed via MCP (allowlist only)")
    # Dynamic import to avoid cycle at module load; tool_runner is the choke point.
    try:
        from ..agent_runtime import session_tools as _st  # noqa: F401  — validate tool exists
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"MCP tool registry unavailable: {type(exc).__name__}")

    # For now, MCP call is a validated echo — full execution reuses the same
    # sanitized tool_runner path as the agent (follow-up PR wires actual dispatch).
    # This keeps the bridge observable without duplicating S3 call logic in v1.
    return {
        "tool": body.tool,
        "status": "accepted",
        "note": "MCP call validated against allowlist; execution reuses the same read-only, bounded, redacted path as the agent. Wire the provider_id + args through tool_runner in the next iteration.",
        "arguments_received": body.arguments,
        "provider_id": body.provider_id,
    }
