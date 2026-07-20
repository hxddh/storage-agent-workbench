"""Deterministic diagnostic run executor.

Drives the existing Phase 03 read-only tools through the shared tool runner so
every call is recorded against the run. Emits SSE events as it goes. No LLM,
no DuckDB, no direct boto3 — and no destructive operations.

A diagnostic that successfully ran its probes COMPLETES even when the target is
unhealthy: the verdict lives in the summary/findings, and 'failed' is reserved
for the executor itself failing (see the shared harness in ``_common``).
"""

from __future__ import annotations

import sqlite3
from typing import Any

from .. import config
from ..events import bus
from ..repositories import cloud_providers as cloud_repo
from ..s3 import tools as s3_tools
from ..s3.scope import check_scope
from ._common import RunError, require_success, run_executor, run_tool_with_events
from .report import write_report

# Bounded sample size for the diagnostic listing (never a full scan).
DIAGNOSTIC_MAX_KEYS = 100
_TOOLS = ["test_credentials", "head_bucket", "list_objects_v2"]


def _finding(severity: str, title: str, detail: str) -> dict[str, str]:
    return {"severity": severity, "title": title, "detail": detail}


def _derive_findings(evidence: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []

    cred = evidence.get("test_credentials", {})
    if cred.get("success"):
        findings.append(_finding("info", "Provider credentials valid",
                                  f"Identity: {cred.get('identity_hint') or 'unknown'}."))
    else:
        findings.append(_finding("error", "Credential check failed",
                                  cred.get("error_message_sanitized") or cred.get("error_code") or "unknown error"))

    hb = evidence.get("head_bucket", {})
    if hb.get("success"):
        findings.append(_finding("info", "Bucket is accessible",
                                  f"HeadBucket returned status {hb.get('status_code')}."))
    else:
        findings.append(_finding("error", "Bucket not accessible",
                                  hb.get("error_message_sanitized") or hb.get("error_code") or "unknown error"))

    lo = evidence.get("list_objects_v2", {})
    if lo.get("success"):
        findings.append(_finding(
            "info", "Object sampling succeeded (bounded)",
            f"Sampled key_count={lo.get('key_count')}; "
            f"{len(lo.get('sample_keys') or [])} sample key(s) shown. "
            "This is a bounded sample, not a full bucket scan.",
        ))
        if lo.get("is_truncated"):
            findings.append(_finding("info", "Listing truncated",
                                     "More objects exist beyond the bounded sample."))
    else:
        findings.append(_finding("error", "Object listing failed",
                                 lo.get("error_message_sanitized") or lo.get("error_code") or "unknown error"))

    return findings


def _summary_text(all_ok: bool, evidence: dict[str, dict[str, Any]]) -> str:
    if all_ok:
        lo = evidence.get("list_objects_v2", {})
        return (
            "Diagnostic completed: credentials valid, bucket accessible, and a "
            f"bounded object sample (key_count={lo.get('key_count')}) was retrieved."
        )
    failed = [n for n in _TOOLS if not evidence.get(n, {}).get("success")]
    return "Diagnostic completed with issues. Failed checks: " + ", ".join(failed) + "."


def execute_diagnostic_run(conn: sqlite3.Connection, run_id: str) -> None:
    run_executor(conn, run_id, "Diagnostic run failed.",
                 lambda run: _diagnostic_body(conn, run_id, run))


def _diagnostic_body(conn: sqlite3.Connection, run_id: str, run: dict[str, Any]) -> str:
    provider_id = run["provider_id"]
    bucket = run["bucket"]
    prefix = run["prefix"]

    provider = cloud_repo.get(conn, provider_id) if provider_id else None
    if provider is not None:
        denial = check_scope(provider.allowed_buckets, provider.allowed_prefixes,
                             bucket, prefix=prefix, listing=True)
        if denial:
            raise RunError(denial)

    evidence: dict[str, dict[str, Any]] = {}

    def call(name: str, raw_input: dict[str, Any], executor) -> dict[str, Any]:
        # Uses the shared started/finished event helper (identical event
        # shape) so the diagnostic executor doesn't drift from the others.
        out = run_tool_with_events(conn, run_id, name, raw_input, executor)
        evidence[name] = out
        return out

    call("test_credentials", {"provider_id": provider_id},
         lambda: s3_tools.test_credentials(conn, provider_id))
    call("head_bucket", {"provider_id": provider_id, "bucket": bucket},
         lambda: s3_tools.head_bucket(conn, provider_id, bucket))
    call("list_objects_v2",
         {"provider_id": provider_id, "bucket": bucket, "max_keys": DIAGNOSTIC_MAX_KEYS, "prefix": prefix},
         lambda: s3_tools.list_objects_v2(conn, provider_id, bucket, DIAGNOSTIC_MAX_KEYS, prefix))

    findings = _derive_findings(evidence)
    for f in findings:
        bus.publish(run_id, {"type": "finding", **f})

    all_ok = all(evidence.get(n, {}).get("success") for n in _TOOLS)
    summary = _summary_text(all_ok, evidence)
    bus.publish(run_id, {"type": "summary", "content": summary})

    # Route report generation through run_tool_with_events like every other
    # executor, so it lands a tool_call + audit row (rule 17: report generation is
    # auditable) instead of writing report.md with no trail.
    require_success(run_tool_with_events(
        conn, run_id, "generate_markdown_report", {"run_id": run_id},
        lambda: {"report_path": config.rel_path(
            write_report(run, evidence, findings, summary)[0]), "format": "markdown"},
    ))
    return summary
