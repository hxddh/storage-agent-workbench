"""Local guardrails for the agent's tool use.

These are enforced in code, NOT merely in the model prompt:
- forbidden-tool denial (defense-in-depth: `is_forbidden_tool` rejects any name
  carrying a dangerous token or a mutating-op phrase — used to sanitize proposed
  action slugs, and asserted over the agent's registered tools in tests)
- tool argument bounds (e.g. list max_keys, range size)
- no-secret assertions on context and outputs
- output sanitization/bounding before results reach the LLM
- report sanitization before a report is saved

The tool *allowlist* is the curated set of `@function_tool`-decorated functions
registered in `session_tools` / `session_action_tools` / `session_analysis_tools`
/ `session_memory_tools` — that registration IS the whitelist (there is no second
static name-set to keep in sync, and no runtime name-match gate: adding a
read-only tool must not require editing a second list). The forbidden-token
denylist below is the belt-and-suspenders that catches a mis-added mutating tool.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..security.redaction import REDACTED, redact, redact_text

SAMPLE_LIMIT = 20
# List sampling in agent mode is graded, not silently clamped to a tiny cap:
# when the caller doesn't ask for a size it gets DEFAULT; it may explicitly
# request up to MAX (which matches the S3 layer's own hard cap, so a deliberate
# wider sample is honored instead of dropped to the default); a request beyond
# MAX is CLAMPED to MAX (bounds, not gates) — there is no human-approval path.
AGENT_DEFAULT_LIST_KEYS = 100
AGENT_MAX_LIST_KEYS = 1000  # bounded no-approval ceiling (== S3 hard cap)
AGENT_MAX_RANGE_BYTES = 1024 * 1024  # 1 MiB no-approval ceiling

# Forbidden surface, matched on whole NAME TOKENS (split on non-alphanumeric),
# not raw substrings — so legitimate names like `test_credentials` or
# `inspect_endpoint_tls` are never falsely blocked by an incidental substring
# (the old check forbade anything merely *containing* "client", "sql", "code"…).
# The curated tool registration is the primary whitelist; this denylist is
# defense-in-depth against a mis-added mutating tool. Single dangerous tokens.
# NOTE: "sql"/"query" are deliberately NOT bare tokens — a constrained,
# parameterized read-only aggregation tool is a legitimate capability, and a
# bare token here would ossify against ever adding one. Only the genuinely
# dangerous SQL-execution *phrases* below are blocked.
FORBIDDEN_TOKENS = {
    "shell", "bash", "sh", "subprocess", "exec", "eval", "system", "popen",
    "python", "boto3", "client",
}
# Mutating/destructive S3 operations and raw-SQL execution, matched as a
# contiguous token sequence so only the actual op is blocked (not any name
# containing "put"/"delete"/"sql").
FORBIDDEN_PHRASES = {
    ("put", "object"), ("delete", "object"), ("delete", "objects"),
    ("delete", "bucket"), ("create", "bucket"), ("copy", "object"),
    ("upload", "file"),
    ("put", "bucket", "policy"), ("put", "bucket", "acl"),
    ("put", "bucket", "lifecycle", "configuration"),
    ("put", "lifecycle", "configuration"),
    ("put", "bucket", "cors"), ("put", "bucket", "encryption"),
    # Raw/arbitrary SQL execution (the constrained aggregate tool never matches:
    # it carries neither an execution verb nor the word "sql" in its name).
    ("run", "sql"), ("execute", "sql"), ("raw", "sql"), ("sql", "query"),
    ("execute", "query"), ("run", "query"), ("sql", "exec"),
}
# Back-compat alias (some callers/tests reference the old name).
FORBIDDEN_TOOLS = FORBIDDEN_TOKENS


class GuardrailBlocked(Exception):
    """Raised when a guardrail blocks an action. Message is safe to surface."""

    def __init__(self, name: str, message: str):
        self.name = name
        super().__init__(message)


def is_forbidden_tool(name: str) -> bool:
    """True if the tool name carries a forbidden token or a mutating-op phrase.

    Matches on whole tokens (split on non-alphanumeric), so an incidental
    substring (e.g. "sh" inside "refresh", "code" inside "error_code") does not
    falsely forbid a legitimate read-only tool.
    """
    import re
    tokens = re.findall(r"[a-z0-9]+", (name or "").lower())
    if set(tokens) & FORBIDDEN_TOKENS:
        return True
    for phrase in FORBIDDEN_PHRASES:
        n = len(phrase)
        if any(tuple(tokens[i:i + n]) == phrase for i in range(len(tokens) - n + 1)):
            return True
    return False


def bound_tool_args(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Clamp argument bounds for no-approval agent execution.

    Unset ``max_keys`` defaults to ``AGENT_DEFAULT_LIST_KEYS``; an explicit
    larger request is honored up to ``AGENT_MAX_LIST_KEYS`` (not silently
    dropped to the default), so a deliberate wider sample works.
    """
    out = dict(args or {})
    if name in ("list_objects_v2", "sample_bucket_objects"):
        mk = int(out.get("max_keys", AGENT_DEFAULT_LIST_KEYS) or AGENT_DEFAULT_LIST_KEYS)
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


# Paired hidden-reasoning blocks: <think>…</think> / <thinking>…</thinking>
# (case-insensitive, spanning newlines). Removed entirely, surrounding text kept.
_THINK_BLOCK = re.compile(r"(?is)<(think|thinking)\b[^>]*>.*?</\1\s*>")
# A leading chain-of-thought preamble (only at the very start of the message).
_LEADING_COT = re.compile(r"(?is)^\s*(chain[\s\-]?of[\s\-]?thought|reasoning|thinking)\s*:")
# Where a leading preamble transitions into the real answer.
_ANSWER_MARKER = re.compile(r"(?is)\n\s*(?:final\s+answer|answer)\s*:\s*")


def strip_chain_of_thought(text: str | None, max_len: int = _COT_BACKSTOP) -> str:
    """Strip hidden reasoning; do NOT cap or drop the visible answer.

    Two moves, both conservative:
    1. Remove paired ``<think>…</think>`` / ``<thinking>…</thinking>`` blocks
       entirely, keeping the surrounding text.
    2. If the message *opens* with a chain-of-thought preamble
       (``Reasoning:``/``Chain of thought:``/``Thinking:``), drop just that
       preamble up to the answer marker or the first blank-line paragraph
       break. A legitimate answer that merely *contains* the word "reasoning:"
       mid-sentence is never truncated.

    Length is bounded by the caller (answer/list caps); ``max_len`` here is only a
    large defensive backstop, never the binding limit.
    """
    if not text:
        return ""
    # 1. Never persist hidden reasoning blocks.
    text = _THINK_BLOCK.sub("", text)
    # 2. Strip a leading CoT preamble only — never mid-answer content.
    if _LEADING_COT.match(text):
        answer_at = _ANSWER_MARKER.search(text)
        if answer_at:
            text = text[answer_at.end():]
        else:
            para = re.search(r"\n\s*\n", text)
            if para:
                text = text[para.end():]
            # else: no separable answer — keep the text rather than drop it all.
    text = text.strip()
    return (text[:max_len] + "…") if len(text) > max_len + 1 else text


def redacted(text: str) -> str:
    return redact_text(text)


__all__ = [
    "GuardrailBlocked", "FORBIDDEN_TOOLS", "FORBIDDEN_TOKENS",
    "FORBIDDEN_PHRASES", "SAMPLE_LIMIT", "AGENT_DEFAULT_LIST_KEYS",
    "AGENT_MAX_LIST_KEYS", "AGENT_MAX_RANGE_BYTES", "REDACTED",
    "is_forbidden_tool", "bound_tool_args",
    "assert_no_secrets_in_context", "sanitize_output_for_agent",
    "assert_report_sanitized", "strip_chain_of_thought", "redacted",
]
