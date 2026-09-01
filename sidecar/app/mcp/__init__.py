"""MCP bridge — opt-in, read-only, local-only.

When STORAGE_AGENT_ENABLE_MCP != "1", the router returns 404 so the
default product has no MCP surface (preserves the security floor).
When enabled, it exposes the whitelisted READ-ONLY storage tools as MCP
tool definitions (list) and a gated call endpoint that reuses the existing
tool_runner with the same bounds/redaction/scope checks.

No new tool surface: the bridge only re-exports tools already registered in
session_tools / agent_runtime — it never adds a generic shell or raw boto3
dispatcher.
"""
