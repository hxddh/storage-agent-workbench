"""Guardrail / contract / investigator-surface units.

The Run-planner agent path was removed in v0.20 (single conversational agent),
so this file no longer exercises a second tool-calling LLM. What remains are the
still-load-bearing safety units: the forbidden-tool denylist, output
sanitization, report/context secret checks, chain-of-thought stripping, the
skill-contract parser, and the read-only investigator toolset the in-chat agent
exposes (whose registration IS the tool whitelist).
"""

import sqlite3

import pytest

from app.agent_runtime import guardrails
from app.agent_runtime.guardrails import GuardrailBlocked

ACCESS = "AKIAIOSFODNN7EXAMPLE"


# --- guardrail units --------------------------------------------------------


def test_guardrail_forbids_destructive_and_shell_tool_names():
    # Defense-in-depth denylist (the allowlist is the curated tool registration,
    # asserted separately over the real registered investigator tools below).
    for bad in ("delete_bucket", "put_bucket_policy", "shell", "subprocess", "run_sql", "boto3_client"):
        assert guardrails.is_forbidden_tool(bad), f"should be forbidden: {bad}"


def test_guardrail_does_not_forbid_legit_readonly_tool_names():
    for ok in ("test_credentials", "head_bucket", "get_bucket_config_summary"):
        assert not guardrails.is_forbidden_tool(ok)


def test_dead_guardrail_helpers_removed():
    # Fix 8: sanitize_output_for_agent / assert_report_sanitized had no
    # production callers (S3-layer sanitization + redact cover tool outputs;
    # reports go through redact_text). The dead helpers, the never-enforced
    # AGENT_MAX_RANGE_BYTES, and the unused FORBIDDEN_TOOLS alias were removed —
    # assert they're gone so they don't creep back as guards nothing wears.
    for gone in ("sanitize_output_for_agent", "assert_report_sanitized",
                 "AGENT_MAX_RANGE_BYTES", "FORBIDDEN_TOOLS"):
        assert not hasattr(guardrails, gone), f"expected {gone} to be removed"


def test_assert_no_secrets_in_context_raises_on_raw_secret():
    with pytest.raises(GuardrailBlocked):
        guardrails.assert_no_secrets_in_context({"x": f"{ACCESS}"})


def test_strip_chain_of_thought_preserves_long_enumerations():
    """Regression: strip_chain_of_thought must NOT chop a long answer to ~500
    chars. It should strip CoT markers only; length is bounded by callers."""
    rows = "\n".join(f"| {i} | bucket-{i:03d} | 2026-01-01 |" for i in range(96))
    table = "Here are all 96 buckets:\n" + rows
    out = guardrails.strip_chain_of_thought(table)
    assert out.count("bucket-") == 96  # every row survives
    assert len(out) > 3000 and "…" not in out  # not truncated
    stripped = guardrails.strip_chain_of_thought("Answer line.\n<thinking>secret plan</thinking>")
    assert "secret" not in stripped and stripped.strip() == "Answer line."


def test_parse_contract_keeps_full_table(client):
    """The full pipeline (contract parse → answer) must not truncate a big table."""
    from app.skills import contract as skill_contract

    rows = "\n".join(f"| {i} | bucket-{i:03d} | 2026-01-01 |" for i in range(96))
    raw = "你共有 96 个 bucket：\n| # | 名称 | 创建时间 |\n|---|---|---|\n" + rows
    out = skill_contract.parse_agent_contract(raw, allowed_skill_names=[])
    assert out["answer"].count("bucket-") == 96


def test_session_investigator_exposes_full_readonly_diagnostic_surface():
    """The in-chat agent is a real diagnostician: it must reach the whole
    read-only diagnostic surface (auth, addressing, TLS, range, object, config),
    and every tool it can call must be read-only (never forbidden/mutating)."""
    from app.agent_runtime import session_tools

    def fake_function_tool(fn):  # mimic the SDK decorator enough for build()
        fn.name = fn.__name__
        return fn

    conn = sqlite3.connect(":memory:")
    try:
        tools = session_tools.build(conn, fake_function_tool, [])
    finally:
        conn.close()
    names = {getattr(t, "name", getattr(t, "__name__", "")) for t in tools}

    expected = {
        "list_providers", "list_buckets", "head_bucket", "list_objects",
        "list_object_versions", "list_multipart_uploads",
        "test_credentials", "head_object", "get_object_lock_status",
        "get_object_acl", "get_object_tagging", "get_object_attributes",
        "list_upload_parts", "diagnose_presigned_url", "test_conditional_get",
        "test_range_get", "preview_object", "measure_request_latency",
        "test_addressing_style", "inspect_endpoint_tls", "read_skill",
        "get_bucket_config_summary", "review_bucket_security",
        "review_bucket_lifecycle", "review_bucket_observability",
        "review_bucket_cost_optimization", "review_bucket_performance_profile",
    }
    assert expected <= names, f"missing investigator tools: {expected - names}"
    # The curated registration IS the whitelist; assert none of it is forbidden.
    for n in names:
        assert not guardrails.is_forbidden_tool(n), f"forbidden tool exposed: {n}"
