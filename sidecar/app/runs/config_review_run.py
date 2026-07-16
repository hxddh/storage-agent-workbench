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
    # The config reads are bucket-metadata (no object listing) — gate them at the
    # bucket level. The performance profile is the ONE sub-tool that LISTS objects
    # (list_objects_v2 at the prefix, defaulting to the bucket root), so it needs
    # the stricter listing gate: a prefix-scoped provider must not have the root
    # listed for it and its out-of-prefix keys persisted. Gated separately below.
    listing_denial: str | None = None
    if provider is not None:
        denial = check_scope(provider.allowed_buckets, provider.allowed_prefixes,
                             bucket, prefix=prefix)
        if denial:
            raise RunError(denial)
        listing_denial = check_scope(provider.allowed_buckets, provider.allowed_prefixes,
                                     bucket, prefix=prefix, listing=True)

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
    if listing_denial:
        # Prefix-scoped provider with no in-scope prefix: skip the object-listing
        # profile entirely rather than list the bucket root out of scope. The rest
        # of the review (bucket-metadata reads) still runs.
        performance = {"success": True, "skipped": True,
                       "facts": {"list_status": "out_of_scope", "inconclusive": True},
                       "findings": [{"category": ct.NOT_APPLICABLE,
                                     "title": "Performance profile skipped (prefix scope)",
                                     "detail": listing_denial}]}
        for f in performance["findings"]:
            bus.publish(run_id, {"type": "finding", "severity": f["category"],
                                 "title": f["title"], "detail": f["detail"]})
            all_findings.append(f)
    else:
        performance = call_and_collect(
            "review_bucket_performance_profile",
            {"provider_id": provider_id, "bucket": bucket, "prefix": prefix},
            lambda: ct.review_bucket_performance_profile(conn, provider_id, bucket, prefix))

    counts = dict(Counter(f["category"] for f in all_findings))
    # The agent tool's contract says "returns its findings for you to narrate" —
    # counts alone forced it to re-run the five review tools individually to see
    # WHAT was found. Fold a bounded, severity-ordered digest of the actual
    # findings into the summary (titles only, ≤12 — the full detail is in the
    # report and the per-aspect tools).
    _SEV_ORDER = {"critical": 0, "warning": 1, "error": 1, "opportunity": 2,
                  "good": 3, "info": 3}
    ordered = sorted(all_findings, key=lambda f: _SEV_ORDER.get(f.get("category", ""), 2))
    digest = "; ".join(f"[{f['category']}] {f['title']}" for f in ordered[:12])
    more = len(all_findings) - min(12, len(all_findings))
    summary_text = (
        f"Read-only configuration review of bucket '{bucket}' "
        f"(overall status: {summary_out.get('overall_status')}). "
        f"Findings: " + ", ".join(f"{n} {c}" for c, n in counts.items()) + "."
        + (f" Details: {digest}" + (f" (+{more} more in the report)" if more > 0 else "") + "."
           if digest else "")
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
