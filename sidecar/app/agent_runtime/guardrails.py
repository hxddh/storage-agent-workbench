"""Local guardrails for agent planner mode (Phase 07).

These are enforced in code, NOT merely in the model prompt:
- tool allowlist + forbidden-tool denial
- tool argument bounds (e.g. list max_keys, range size)
- no-secret assertions on context and outputs
- output sanitization/bounding before results reach the LLM
- report sanitization before a report is saved
"""

from __future__ import annotations

import json
from typing import Any

from ..security.redaction import REDACTED, redact, redact_text

SAMPLE_LIMIT = 20
AGENT_MAX_LIST_KEYS = 100  # no-approval ceiling for list sampling in agent mode
AGENT_MAX_RANGE_BYTES = 1024 * 1024  # 1 MiB no-approval ceiling

# The ONLY tools an agent may call (the existing whitelist).
ALLOWED_TOOLS = {
    # diagnostic / read-only S3
    "test_credentials", "head_bucket", "list_objects_v2", "head_object",
    "test_path_style_vs_virtual_host", "inspect_tls",
    # analysis
    "detect_log_format", "import_access_logs", "analyze_access_logs",
    "import_inventory_file", "analyze_inventory",
    # config review
    "get_bucket_config_summary", "review_bucket_security", "review_bucket_lifecycle",
    "review_bucket_observability", "review_bucket_cost_optimization",
    "review_bucket_performance_profile",
    # report
    "generate_markdown_report",
}

# Names that must never be registered or invoked. Substring match too.
FORBIDDEN_TOOLS = {
    "shell", "bash", "sh", "subprocess", "exec", "eval", "system", "popen",
    "python", "code", "sql", "query", "put_object", "delete_object",
    "delete_objects", "delete_bucket", "put_bucket_policy", "put_bucket_acl",
    "put_bucket_lifecycle_configuration", "put_lifecycle_configuration",
    "put_bucket_cors", "put_bucket_encryption", "copy_object", "upload_file",
    "create_bucket", "boto3", "client",
}

# Approval framework categories (Phase 07: data model only; nothing dangerous runs).
NO_APPROVAL_REQUIRED = "no_approval_required"
APPROVAL_REQUIRED = "approval_required"
ALWAYS_FORBIDDEN = "always_forbidden"


class GuardrailBlocked(Exception):
    """Raised when a guardrail blocks an action. Message is safe to surface."""

    def __init__(self, name: str, message: str):
        self.name = name
        super().__init__(message)


def is_forbidden_tool(name: str) -> bool:
    low = (name or "").lower()
    return any(bad in low for bad in FORBIDDEN_TOOLS)


def check_tool_allowed(name: str) -> None:
    """Raise GuardrailBlocked unless ``name`` is explicitly allowlisted."""
    if is_forbidden_tool(name):
        raise GuardrailBlocked("no_destructive_tool", f"Tool '{name}' is forbidden.")
    if name not in ALLOWED_TOOLS:
        raise GuardrailBlocked("tool_allowlist", f"Tool '{name}' is not in the allowlist.")


def approval_category(name: str, args: dict[str, Any]) -> str:
    if is_forbidden_tool(name):
        return ALWAYS_FORBIDDEN
    if name in ("list_objects_v2", "sample_bucket_objects") and int(args.get("max_keys", 0) or 0) > AGENT_MAX_LIST_KEYS:
        return APPROVAL_REQUIRED
    return NO_APPROVAL_REQUIRED


def bound_tool_args(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Clamp argument bounds for no-approval agent execution."""
    out = dict(args or {})
    if name in ("list_objects_v2", "sample_bucket_objects"):
        mk = int(out.get("max_keys", AGENT_MAX_LIST_KEYS) or AGENT_MAX_LIST_KEYS)
        out["max_keys"] = max(1, min(mk, AGENT_MAX_LIST_KEYS))
    return out


def _contains_secret(text: str) -> bool:
    # redact_text replaces credential-shaped substrings; if it changed the text,
    # a secret-shaped value was present.
    return redact_text(text) != text or "keyring://" in text


def assert_no_secrets_in_context(context: Any) -> None:
    """Raise GuardrailBlocked if the LLM context contains secret-shaped content."""
    text = context if isinstance(context, str) else json.dumps(context, default=str)
    if _contains_secret(text):
        raise GuardrailBlocked("no_secret_in_context", "Refusing to send secret-shaped content to the LLM.")


_DROP_KEYS = {"headers_sanitized", "raw", "raw_sanitized", "policy", "acl", "data"}


def sanitize_output_for_agent(output: dict[str, Any]) -> dict[str, Any]:
    """Return a bounded, redacted summary safe to hand back to the LLM."""
    safe = redact(output)  # mask any secret-shaped values defensively

    def _bound(value: Any, key: str | None = None) -> Any:
        if isinstance(value, dict):
            return {k: _bound(v, k) for k, v in value.items() if k not in _DROP_KEYS}
        if isinstance(value, list):
            return [_bound(v) for v in value[:SAMPLE_LIMIT]]
        return value

    return _bound(safe)


def assert_report_sanitized(content: str) -> None:
    """Raise GuardrailBlocked if the report still contains secret-shaped content."""
    if _contains_secret(content):
        raise GuardrailBlocked("report_sanitization", "Report failed sanitization; not saved.")


_COT_BACKSTOP = 60000  # defensive only; callers bound the real length (answer
# caps live in skills.contract / session_agent). Must stay ABOVE those caps so
# this never silently truncates a legitimate long answer (e.g. a 96-row table).


def strip_chain_of_thought(text: str | None, max_len: int = _COT_BACKSTOP) -> str:
    """Strip hidden reasoning; do NOT cap the visible answer.

    Drops anything after a chain-of-thought marker so reasoning is never
    persisted. Length is bounded by the caller (answer/list caps); the
    ``max_len`` here is only a large defensive backstop, never the binding limit.
    """
    if not text:
        return ""
    lowered = text.lower()
    for marker in ("chain of thought", "chain-of-thought", "<thinking", "reasoning:"):
        idx = lowered.find(marker)
        if idx != -1:
            text = text[:idx]
            break
    text = text.strip()
    return (text[:max_len] + "…") if len(text) > max_len + 1 else text


def redacted(text: str) -> str:
    return redact_text(text)


__all__ = [
    "GuardrailBlocked", "ALLOWED_TOOLS", "FORBIDDEN_TOOLS", "SAMPLE_LIMIT",
    "AGENT_MAX_LIST_KEYS", "AGENT_MAX_RANGE_BYTES", "REDACTED",
    "check_tool_allowed", "is_forbidden_tool", "approval_category", "bound_tool_args",
    "assert_no_secrets_in_context", "sanitize_output_for_agent",
    "assert_report_sanitized", "strip_chain_of_thought", "redacted",
]
