"""The read-only MCP server (opt-in: ``STORAGE_AGENT_ENABLE_MCP=1``).

Built on the official MCP Python SDK and served over Streamable HTTP at
``/mcp`` behind the same per-launch token as every other route. It exposes the
stateless, read-only subset of the Agent's own tool registry — the same scope
check, bounds and redaction, audited as ``actor=mcp``. Tools that belong to a
task (surveys, files, imports, the conclusion) are not exposed: the bridge has
no task to record them in.
"""

from __future__ import annotations

import inspect
import os
from typing import Any

from ..agent.tools import registry
from ..db import connect
from ..providers import clouds

ENABLED = os.environ.get("STORAGE_AGENT_ENABLE_MCP") == "1"
_GROUPS = frozenset({"probes", "objects", "config"})
_EXTRA = frozenset({"list_buckets", "head_bucket", "read_skill", "query_estate", "triage_error"})
_NEVER = frozenset({"note", "record_conclusion"})  # the estate's memory and the conclusion belong to a task


def exposed() -> frozenset[str]:
    return frozenset(n for n, td in registry.REGISTRY.items()
                     if (td.group in _GROUPS or n in _EXTRA) and n not in _NEVER)


def _bridge(name: str) -> Any:
    td = registry.REGISTRY[name]
    allowed = exposed()

    def call(**kwargs: Any) -> Any:
        return registry.call_direct(name, kwargs, actor="mcp", allowed=allowed)

    call.__name__ = name
    call.__doc__ = td.fn.__doc__
    # Resolved in the tool's own module: its annotations (Literal choices) name types defined there.
    call.__signature__ = inspect.signature(td.fn, eval_str=True)  # type: ignore[attr-defined]
    return call


def build_server() -> Any:
    from mcp.server.mcpserver import MCPServer
    from mcp.types import ToolAnnotations

    from .. import __version__

    server = MCPServer(name="storage-agent", title="Storage Agent (read-only)", version=__version__,
                       instructions="Read-only diagnostics for the object storage accounts configured in "
                                    "Storage Agent. Nothing here writes to storage. Call list_providers first.")
    read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=True)

    def list_providers() -> list[dict[str, Any]]:
        """The configured storage accounts (id, name, type, region, scope). Never credentials."""
        conn = connect()
        try:
            return [{k: c.public()[k] for k in ("id", "name", "provider_type", "region", "allowed_buckets",
                                                 "allowed_prefixes")} for c in clouds.list_all(conn)]
        finally:
            conn.close()

    server.add_tool(list_providers, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    for name in sorted(exposed()):
        server.add_tool(_bridge(name), name=name, annotations=read_only)
    return server


SERVER = build_server() if ENABLED else None
