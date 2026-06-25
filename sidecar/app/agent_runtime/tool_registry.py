"""Allowlisted tool registry for agent mode (Phase 07).

Maps an allowlisted tool name to a thin executor over the EXISTING tool
functions. The agent never supplies provider_id / bucket / prefix — those are
fixed by the run, so the agent cannot pivot to another provider or bucket. Only
a few bounded parameters (e.g. key, max_keys) come from the agent.

No S3 code is duplicated here; executors delegate to app.s3 / app.s3.config_tools.
The shared tool_runner records every call (see ToolInvoker in agent_service).
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import Any

from ..s3 import config_tools as ct
from ..s3 import tools as s3
from . import guardrails

# Each executor: (conn, ctx, args) -> full tool output dict.
# ctx holds provider_id / bucket / prefix / endpoint_url from the run.
Executor = Callable[[sqlite3.Connection, dict, dict], dict]


def _e_test_credentials(conn, ctx, args):
    return s3.test_credentials(conn, ctx["provider_id"])


def _e_head_bucket(conn, ctx, args):
    return s3.head_bucket(conn, ctx["provider_id"], ctx["bucket"])


def _e_list_objects_v2(conn, ctx, args):
    bounded = guardrails.bound_tool_args("list_objects_v2", args)
    prefix = args.get("prefix", ctx.get("prefix"))
    return s3.list_objects_v2(conn, ctx["provider_id"], ctx["bucket"], bounded["max_keys"], prefix)


def _e_head_object(conn, ctx, args):
    key = str(args.get("key", "")).strip()
    if not key:
        return {"success": False, "error_code": "InvalidArgument",
                "error_message_sanitized": "head_object requires a 'key'."}
    return s3.head_object(conn, ctx["provider_id"], ctx["bucket"], key)


def _e_path_style(conn, ctx, args):
    return s3.test_path_style_vs_virtual_host(conn, ctx["provider_id"], ctx["bucket"])


def _e_inspect_tls(conn, ctx, args):
    endpoint = ctx.get("endpoint_url")
    if not endpoint:
        return {"error_message_sanitized": "No endpoint_url configured for this provider."}
    return s3.inspect_tls(endpoint)


def _cfg(fn):
    def _inner(conn, ctx, args):
        return fn(conn, ctx["provider_id"], ctx["bucket"])
    return _inner


def _e_perf(conn, ctx, args):
    return ct.review_bucket_performance_profile(conn, ctx["provider_id"], ctx["bucket"], ctx.get("prefix"))


TOOL_EXECUTORS: dict[str, Executor] = {
    "test_credentials": _e_test_credentials,
    "head_bucket": _e_head_bucket,
    "list_objects_v2": _e_list_objects_v2,
    "head_object": _e_head_object,
    "test_path_style_vs_virtual_host": _e_path_style,
    "inspect_tls": _e_inspect_tls,
    "get_bucket_config_summary": _cfg(ct.get_bucket_config_summary),
    "review_bucket_security": _cfg(ct.review_bucket_security),
    "review_bucket_lifecycle": _cfg(ct.review_bucket_lifecycle),
    "review_bucket_observability": _cfg(ct.review_bucket_observability),
    "review_bucket_cost_optimization": _cfg(ct.review_bucket_cost_optimization),
    "review_bucket_performance_profile": _e_perf,
}

# Short descriptions so the agent knows what each tool does.
TOOL_SPECS: dict[str, str] = {
    "test_credentials": "Validate provider credentials with a read-only call.",
    "head_bucket": "Check that the configured bucket is reachable.",
    "list_objects_v2": "List a bounded object sample (max_keys<=100). Args: max_keys?, prefix?.",
    "head_object": "Read metadata for one object. Args: key.",
    "test_path_style_vs_virtual_host": "Compare path- vs virtual-hosted addressing.",
    "inspect_tls": "Inspect the endpoint TLS certificate.",
    "get_bucket_config_summary": "Summarize readable bucket configuration statuses.",
    "review_bucket_security": "Review security posture (policy/CORS/encryption/ACL/PAB).",
    "review_bucket_lifecycle": "Review lifecycle rules and versioning cleanup.",
    "review_bucket_observability": "Review logging/notification/tagging.",
    "review_bucket_cost_optimization": "Review cost-optimization opportunities.",
    "review_bucket_performance_profile": "Profile performance from a bounded object sample.",
}

# Tools relevant to each agent-supported run type.
TOOLS_FOR_RUN_TYPE: dict[str, list[str]] = {
    "diagnostic": ["test_credentials", "head_bucket", "list_objects_v2"],
    "bucket_config_review": [
        "get_bucket_config_summary", "review_bucket_security", "review_bucket_lifecycle",
        "review_bucket_observability", "review_bucket_cost_optimization",
        "review_bucket_performance_profile",
    ],
}


def get_executor(name: str) -> Executor | None:
    return TOOL_EXECUTORS.get(name)


def available_tool_names() -> list[str]:
    return sorted(TOOL_EXECUTORS.keys())


def assert_registry_is_safe() -> None:
    """Self-check: the registry must contain only allowlisted, non-forbidden tools."""
    for name in TOOL_EXECUTORS:
        if guardrails.is_forbidden_tool(name) or name not in guardrails.ALLOWED_TOOLS:
            raise guardrails.GuardrailBlocked("tool_allowlist", f"Illegal tool in registry: {name}")
