"""Account discovery run executor.

Deterministic, account-level read-only discovery:

    test_credentials -> list_buckets -> (per visible bucket, bounded by
    max_buckets) head_bucket + config snapshot + evidence-source discovery ->
    account profile + report.

It never scans objects (no ListObjectsV2 here), never downloads object bodies,
never pulls a full inventory report or access log, and never mutates any bucket
configuration. Each bucket's reads are isolated: a failure on one bucket is
recorded and the run continues. account_discovery is deterministic only — Agent
mode is rejected with a clean 422 at the API layer.
"""

from __future__ import annotations

import fnmatch
import json
import sqlite3
from collections import Counter
from typing import Any

from .. import config
from ..events import bus
from ..repositories import account_discovery as account_repo
from ..repositories import runs as runs_repo
from ..s3 import account_tools, tools as s3tools
from ..security.redaction import redact_text
from ._common import RunError, run_tool_with_events
from .analysis_report import render_account_profile, write
from .report import report_path_for

DEFAULT_MAX_BUCKETS = 100
HARD_MAX_BUCKETS = 500
_CONFIGURED = "available"
_NOT_CONFIGURED = "not_configured"
_UNSUPPORTED = "provider_unsupported"
_DENIED = "access_denied"


def _parse_options(run: dict[str, Any]) -> dict[str, Any]:
    try:
        opts = json.loads(run.get("options_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        opts = {}
    raw_max = opts.get("max_buckets")
    try:
        max_buckets = int(raw_max) if raw_max is not None else DEFAULT_MAX_BUCKETS
    except (TypeError, ValueError):
        max_buckets = DEFAULT_MAX_BUCKETS
    max_buckets = max(1, min(max_buckets, HARD_MAX_BUCKETS))
    return {
        "max_buckets": max_buckets,
        "include_pattern": (opts.get("include_pattern") or "").strip() or None,
        "exclude_pattern": (opts.get("exclude_pattern") or "").strip() or None,
    }


def _filter_buckets(names: list[str], include: str | None, exclude: str | None) -> list[str]:
    out = names
    if include:
        out = [n for n in out if fnmatch.fnmatch(n, include)]
    if exclude:
        out = [n for n in out if not fnmatch.fnmatch(n, exclude)]
    return out


def _count(buckets: list[dict[str, Any]], field: str, value: str) -> int:
    return sum(1 for b in buckets if b.get(field) == value)


def _build_summary(buckets: list[dict[str, Any]], visible: int, processed: int, truncated: bool) -> dict[str, Any]:
    def names_where(pred) -> list[str]:
        return [b["bucket_name"] for b in buckets if pred(b)]

    with_inventory = names_where(
        lambda b: any(s.get("source_type") == "inventory" and s.get("status") == _CONFIGURED
                      for s in b.get("evidence_sources", []))
    )
    with_logging = names_where(
        lambda b: any(s.get("source_type") == "server_access_logging" and s.get("status") == _CONFIGURED
                      for s in b.get("evidence_sources", []))
    )
    needs_review = names_where(
        lambda b: b.get("encryption_status") == _NOT_CONFIGURED
        or b.get("public_access_block_status") == _NOT_CONFIGURED
    )
    access_denied = names_where(lambda b: b.get("access_status") == _DENIED)
    errored = names_where(lambda b: b.get("access_status") == "error")

    return {
        "visible_buckets": visible,
        "processed_buckets": processed,
        "truncated": truncated,
        "encryption_configured": _count(buckets, "encryption_status", _CONFIGURED),
        "encryption_not_configured": _count(buckets, "encryption_status", _NOT_CONFIGURED),
        "encryption_unsupported": _count(buckets, "encryption_status", _UNSUPPORTED),
        "logging_configured": _count(buckets, "logging_status", _CONFIGURED),
        "logging_not_configured": _count(buckets, "logging_status", _NOT_CONFIGURED),
        "logging_unsupported": _count(buckets, "logging_status", _UNSUPPORTED),
        "inventory_configured": _count(buckets, "inventory_status", _CONFIGURED),
        "inventory_not_configured": _count(buckets, "inventory_status", _NOT_CONFIGURED),
        "inventory_unsupported": _count(buckets, "inventory_status", _UNSUPPORTED),
        "lifecycle_configured": _count(buckets, "lifecycle_status", _CONFIGURED),
        "lifecycle_not_configured": _count(buckets, "lifecycle_status", _NOT_CONFIGURED),
        "public_access_block_configured": _count(buckets, "public_access_block_status", _CONFIGURED),
        "buckets_with_inventory_evidence": with_inventory,
        "buckets_with_logging_evidence": with_logging,
        "buckets_needing_review": needs_review,
        "access_denied_buckets": access_denied,
        "error_buckets": errored,
    }


def execute_account_discovery_run(conn: sqlite3.Connection, run_id: str) -> None:
    row = runs_repo.get_row(conn, run_id)
    if row is None:
        bus.publish(run_id, {"type": "error", "message": "run not found"})
        bus.mark_done(run_id)
        return
    run = dict(row)
    provider_id = run["provider_id"]

    try:
        if not provider_id:
            raise RunError("account_discovery requires a cloud provider.")
        runs_repo.set_status(conn, run_id, "running")
        opts = _parse_options(run)
        max_buckets = opts["max_buckets"]

        run_tool_with_events(
            conn, run_id, "test_credentials", {"provider_id": provider_id},
            lambda: s3tools.test_credentials(conn, provider_id),
        )

        lb = run_tool_with_events(
            conn, run_id, "list_buckets", {"provider_id": provider_id},
            lambda: s3tools.list_buckets(conn, provider_id),
        )
        list_status = lb.get("status", "error")
        all_names = [b["name"] for b in lb.get("buckets", []) or []]
        visible = len(all_names)
        if list_status != _CONFIGURED:
            bus.publish(run_id, {"type": "summary",
                                 "content": f"ListBuckets {list_status}; cannot enumerate the account."})

        filtered = _filter_buckets(all_names, opts["include_pattern"], opts["exclude_pattern"])
        truncated = len(filtered) > max_buckets
        selected = filtered[:max_buckets]
        if truncated:
            bus.publish(run_id, {"type": "summary",
                                 "content": f"{len(filtered)} bucket(s) matched; processing the first "
                                            f"{max_buckets} (max_buckets). The rest are not analyzed."})

        snapshot_id = account_repo.create_snapshot(
            conn, run_id, provider_id,
            bucket_count=visible, visible_count=visible, processed_count=len(selected),
            truncated=truncated, list_status=list_status, summary={},
        )

        per_bucket: list[dict[str, Any]] = []
        for name in selected:
            access_status = _CONFIGURED
            try:
                snap = run_tool_with_events(
                    conn, run_id, "get_bucket_config_snapshot",
                    {"provider_id": provider_id, "bucket": name},
                    lambda n=name: account_tools.get_bucket_config_snapshot(conn, provider_id, n),
                )
                ev = run_tool_with_events(
                    conn, run_id, "discover_evidence_sources",
                    {"provider_id": provider_id, "bucket": name},
                    lambda n=name: account_tools.discover_evidence_sources(conn, provider_id, n),
                )
                head = snap.get("head_bucket_status")
                # A denied/errored HeadBucket means the bucket itself is
                # inaccessible — report that regardless of whether a region is
                # set. (The snapshot falls back to the provider's configured
                # region, so `region` is almost always truthy even for a fully
                # denied bucket; gating on `not region` made this branch dead and
                # denied buckets were mis-reported as "available".)
                if head == _DENIED:
                    access_status = _DENIED
                elif head == "error":
                    access_status = "error"
                elif snap.get("access_denied_items"):
                    access_status = _CONFIGURED  # partial; reads mostly worked
                sources = ev.get("sources", []) or []
                bucket_entry = {
                    **{k: v for k, v in snap.items() if k not in ("success", "bucket")},
                    "bucket_name": name,
                    "access_status": access_status,
                    "evidence_sources": sources,
                }
            except Exception as exc:  # noqa: BLE001 - per-bucket isolation
                bus.publish(run_id, {"type": "finding", "severity": "warning",
                                     "title": f"Bucket {name}: discovery error",
                                     "detail": redact_text(str(exc))})
                bucket_entry = {
                    "bucket_name": name, "access_status": "error", "region": None,
                    "errors": ["snapshot"], "evidence_sources": [],
                }

            per_bucket.append(bucket_entry)
            account_repo.add_bucket(conn, snapshot_id, run_id, provider_id, name,
                                    bucket_entry.get("region"), bucket_entry["access_status"])
            account_repo.add_config_snapshot(conn, snapshot_id, run_id, provider_id, name, bucket_entry)
            for src in bucket_entry.get("evidence_sources", []):
                account_repo.add_evidence_source(conn, snapshot_id, run_id, provider_id, name, src)
            conn.commit()

        summary = _build_summary(per_bucket, visible, len(per_bucket), truncated)
        # Persist the computed summary onto the snapshot row.
        conn.execute(
            "UPDATE account_snapshots SET summary_json_sanitized = ? WHERE id = ?",
            (json.dumps(summary), snapshot_id),
        )
        conn.commit()

        # A few account-level findings (bounded; no per-object detail).
        if summary["encryption_not_configured"]:
            bus.publish(run_id, {"type": "finding", "severity": "warning",
                                 "title": "Buckets without default encryption",
                                 "detail": f"{summary['encryption_not_configured']} bucket(s) have no default encryption."})
        if summary["buckets_with_inventory_evidence"]:
            bus.publish(run_id, {"type": "finding", "severity": "info",
                                 "title": "Inventory evidence available",
                                 "detail": f"{len(summary['buckets_with_inventory_evidence'])} bucket(s) have an "
                                           "inventory configuration that can feed inventory_analysis."})
        if summary["buckets_with_logging_evidence"]:
            bus.publish(run_id, {"type": "finding", "severity": "info",
                                 "title": "Access-log evidence available",
                                 "detail": f"{len(summary['buckets_with_logging_evidence'])} bucket(s) have server "
                                           "access logging that can feed access_log_analysis."})

        counts = dict(Counter(b["access_status"] for b in per_bucket))
        summary_text = (
            f"Account discovery via provider '{provider_id}': {visible} bucket(s) visible, "
            f"{len(per_bucket)} processed{' (truncated)' if truncated else ''}. "
            f"Access status: " + (", ".join(f"{n} {s}" for s, n in counts.items()) or "—") + "."
        )
        bus.publish(run_id, {"type": "summary", "content": summary_text})

        profile = {
            "run_id": run_id, "provider_id": provider_id, "bucket_count": visible,
            "visible_count": visible, "processed_count": len(per_bucket),
            "truncated": truncated, "list_status": list_status,
            "summary": summary, "buckets": per_bucket,
        }
        content = render_account_profile(run, profile, summary_text)
        run_tool_with_events(
            conn, run_id, "generate_markdown_report", {"run_id": run_id},
            lambda: {"report_path": config.rel_path(write(run_id, content)), "format": "markdown"},
        )

        report_abs = str(report_path_for(run_id))
        conn.execute(
            "INSERT INTO reports (id, run_id, report_path, format, created_at) "
            "VALUES (lower(hex(randomblob(16))), ?, ?, 'markdown', datetime('now'))",
            (run_id, report_abs),
        )
        conn.commit()
        runs_repo.set_status(conn, run_id, "completed", final_summary=summary_text, report_path=report_abs)
        bus.publish(run_id, {"type": "report_ready", "run_id": run_id, "report_path": config.rel_path(report_abs)})
    except Exception as exc:  # noqa: BLE001 - sanitized below
        runs_repo.set_status(conn, run_id, "failed", final_summary="Account discovery failed.")
        bus.publish(run_id, {"type": "error", "message": redact_text(str(exc))})
    finally:
        bus.mark_done(run_id)
