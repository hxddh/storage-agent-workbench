"""Deterministic diagnostic run executor (Phase 04).

Drives the existing Phase 03 read-only tools through the shared tool runner so
every call is recorded against the run. Emits SSE events as it goes. No LLM,
no DuckDB, no direct boto3 — and no destructive operations.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from ..events import bus
from ..repositories import runs as runs_repo
from ..s3 import tools as s3_tools
from ..security.redaction import redact_text
from ..tool_runner import run_tool
from .planner import diagnostic_plan
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
    row = runs_repo.get_row(conn, run_id)
    if row is None:
        bus.publish(run_id, {"type": "error", "message": "run not found"})
        bus.mark_done(run_id)
        return

    run = dict(row)
    provider_id = run["provider_id"]
    bucket = run["bucket"]
    prefix = run["prefix"]

    try:
        runs_repo.set_status(conn, run_id, "running")
        plan = diagnostic_plan(bucket, prefix)
        bus.publish(run_id, {"type": "plan", "content": "\n".join(plan)})

        evidence: dict[str, dict[str, Any]] = {}

        def call(name: str, raw_input: dict[str, Any], executor) -> dict[str, Any]:
            tool_call_id = uuid.uuid4().hex
            bus.publish(run_id, {"type": "tool_call_started", "tool_name": name, "tool_call_id": tool_call_id})
            out = run_tool(conn, name, raw_input, executor, run_id=run_id)
            status = "success" if out.get("success", True) else "error"
            bus.publish(run_id, {
                "type": "tool_call_finished",
                "tool_name": name,
                "tool_call_id": tool_call_id,
                "status": status,
                "output": out,  # already sanitized by the tool layer
            })
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

        report_path, _ = write_report(run, plan, evidence, findings, summary)
        conn.execute(
            "INSERT INTO reports (id, run_id, report_path, format, created_at) "
            "VALUES (?, ?, ?, 'markdown', datetime('now'))",
            (uuid.uuid4().hex, run_id, report_path),
        )
        conn.commit()

        final_status = "completed" if all_ok else "failed"
        runs_repo.set_status(conn, run_id, final_status, final_summary=summary, report_path=report_path)
        bus.publish(run_id, {"type": "report_ready", "run_id": run_id, "report_path": report_path})
    except Exception as exc:  # noqa: BLE001 - sanitized below
        runs_repo.set_status(conn, run_id, "failed", final_summary="Diagnostic run failed.")
        bus.publish(run_id, {"type": "error", "message": redact_text(str(exc))})
    finally:
        bus.mark_done(run_id)
