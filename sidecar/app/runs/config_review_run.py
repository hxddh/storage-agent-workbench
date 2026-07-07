"""Bucket configuration review run executor.

Drives the six READ-ONLY config review tools through the shared tool runner so
every call is recorded against the run. No mutation, no auto-remediation, no
object body download, no LLM.
"""

from __future__ import annotations

import sqlite3
from collections import Counter
from typing import Any

from .. import config
from ..events import bus
from ..repositories import cloud_providers as cloud_repo
from ..s3 import config_tools as ct
from ..s3.scope import check_scope
from ._common import RunError, run_executor, run_tool_with_events
from .analysis_report import render_config_review, write


def execute_config_review_run(conn: sqlite3.Connection, run_id: str) -> None:
    run_executor(conn, run_id, "Bucket configuration review failed.",
                 lambda run: _body(conn, run_id, run))


def _body(conn: sqlite3.Connection, run_id: str, run: dict[str, Any]) -> str:
    provider_id = run["provider_id"]
    bucket = run["bucket"]
    prefix = run["prefix"]

    if not provider_id or not bucket:
        raise RunError("bucket_config_review requires a provider and bucket.")

    provider = cloud_repo.get(conn, provider_id)
    if provider is not None:
        denial = check_scope(provider.allowed_buckets, provider.allowed_prefixes,
                             bucket, prefix=prefix)
        if denial:
            raise RunError(denial)

    all_findings: list[dict[str, str]] = []

    def call_and_collect(name: str, raw_input: dict[str, Any], executor) -> dict[str, Any]:
        out = run_tool_with_events(conn, run_id, name, raw_input, executor)
        for f in out.get("findings", []) or []:
            # Config findings use 'category'; map to the SSE 'severity' slot.
            bus.publish(run_id, {"type": "finding", "severity": f["category"],
                                 "title": f["title"], "detail": f["detail"]})
            all_findings.append(f)
        return out

    summary_out = call_and_collect(
        "get_bucket_config_summary", {"provider_id": provider_id, "bucket": bucket},
        lambda: ct.get_bucket_config_summary(conn, provider_id, bucket))
    security = call_and_collect(
        "review_bucket_security", {"provider_id": provider_id, "bucket": bucket},
        lambda: ct.review_bucket_security(conn, provider_id, bucket))
    lifecycle = call_and_collect(
        "review_bucket_lifecycle", {"provider_id": provider_id, "bucket": bucket},
        lambda: ct.review_bucket_lifecycle(conn, provider_id, bucket))
    observability = call_and_collect(
        "review_bucket_observability", {"provider_id": provider_id, "bucket": bucket},
        lambda: ct.review_bucket_observability(conn, provider_id, bucket))
    cost = call_and_collect(
        "review_bucket_cost_optimization", {"provider_id": provider_id, "bucket": bucket},
        lambda: ct.review_bucket_cost_optimization(conn, provider_id, bucket))
    performance = call_and_collect(
        "review_bucket_performance_profile",
        {"provider_id": provider_id, "bucket": bucket, "prefix": prefix},
        lambda: ct.review_bucket_performance_profile(conn, provider_id, bucket, prefix))

    counts = dict(Counter(f["category"] for f in all_findings))
    summary_text = (
        f"Read-only configuration review of bucket '{bucket}' "
        f"(overall status: {summary_out.get('overall_status')}). "
        f"Findings: " + ", ".join(f"{n} {c}" for c, n in counts.items()) + "."
    )
    bus.publish(run_id, {"type": "summary", "content": summary_text})

    sections = {
        "security": security,
        "lifecycle": lifecycle,
        "observability": observability,
        "cost": cost,
        "performance": performance,
    }
    content = render_config_review(run, summary_out, sections, counts, summary_text)
    run_tool_with_events(
        conn, run_id, "generate_markdown_report", {"run_id": run_id},
        lambda: {"report_path": config.rel_path(write(run_id, content)), "format": "markdown"},
    )
    return summary_text
