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
from ..repositories import cloud_providers as cloud_repo
from ..s3 import account_tools, tools as s3tools
from ..s3.scope import check_scope
from ..security.redaction import redact_text
from ._common import RunError, require_success, run_executor, run_tool_with_events
from .analysis_report import render_account_profile, write

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
    # Public exposure is the survey's most critical fact — a policy-public or
    # ACL-public bucket makes the review list regardless of anything else.
    public_buckets = names_where(lambda b: b.get("publicly_exposed") is True
                                 or b.get("policy_is_public") is True)
    needs_review = names_where(
        lambda b: b.get("encryption_status") == _NOT_CONFIGURED
        or b.get("public_access_block_status") == _NOT_CONFIGURED
        or b.get("publicly_exposed") is True
        or b.get("policy_is_public") is True
    )
    access_denied = names_where(lambda b: b.get("access_status") == _DENIED)
    errored = names_where(lambda b: b.get("access_status") == "error")

    return {
        "public_buckets": public_buckets,
        "public_bucket_count": len(public_buckets),
        "acls_disabled_count": sum(1 for b in buckets if b.get("acls_disabled") is True),
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
    run_executor(conn, run_id, "Account discovery failed.",
                 lambda run: _body(conn, run_id, run))


def _body(conn: sqlite3.Connection, run_id: str, run: dict[str, Any]) -> str:
    provider_id = run["provider_id"]
    if not provider_id:
        raise RunError("account_discovery requires a cloud provider.")
    opts = _parse_options(run)
    max_buckets = opts["max_buckets"]

    provider = cloud_repo.get(conn, provider_id)
    allowed_buckets = provider.allowed_buckets if provider else None
    allowed_prefixes = provider.allowed_prefixes if provider else None

    cred = run_tool_with_events(
        conn, run_id, "test_credentials", {"provider_id": provider_id},
        lambda: s3tools.test_credentials(conn, provider_id),
    )
    # Reflect the credential probe in the findings instead of discarding it.
    if cred.get("success"):
        bus.publish(run_id, {"type": "finding", "severity": "info",
                             "title": "Provider credentials valid",
                             "detail": f"Identity: {cred.get('identity_hint') or 'unknown'}."})
    else:
        bus.publish(run_id, {"type": "finding", "severity": "error",
                             "title": "Credential check failed",
                             "detail": cred.get("error_message_sanitized")
                             or cred.get("error_code") or "unknown error"})

    lb = run_tool_with_events(
        conn, run_id, "list_buckets", {"provider_id": provider_id},
        lambda: s3tools.list_buckets(conn, provider_id),
    )
    list_status = lb.get("status", "error")
    all_names = [b["name"] for b in lb.get("buckets", []) or []]
    visible = len(all_names)
    if list_status != _CONFIGURED:
        # Total failure: ListBuckets could not enumerate the account, so there is
        # nothing to profile. Fail the run (not a misleading "completed") and let
        # the harness persist the reason — including the credential verdict — in
        # final_summary. A per-bucket failure below is different: it is isolated
        # and the run still completes.
        cred_note = ("credentials valid" if cred.get("success")
                     else f"credential check {'failed' if not cred.get('success') else 'ok'} "
                          f"({cred.get('error_code') or 'unknown'})")
        raise RunError(
            f"ListBuckets {list_status}; cannot enumerate the account "
            f"({cred_note}). "
            + (redact_text(lb.get("error_message_sanitized") or "") or "").strip()
        )

    filtered = _filter_buckets(all_names, opts["include_pattern"], opts["exclude_pattern"])
    # Provider scoping (fix): honor allowed_buckets on the deterministic path too,
    # not only inside the agent's tools. Empty/None list means unrestricted.
    if allowed_buckets or allowed_prefixes:
        filtered = [n for n in filtered
                    if check_scope(allowed_buckets, allowed_prefixes, n) is None]
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
            # Strip `_raw_reads` INSIDE the recorded callable so run_tool_with_events
            # persists the cleaned snapshot — popping it after the call (as before)
            # left the raw logging/inventory reads in the committed tool_call row,
            # contradicting the "never persist" contract and ~doubling the row.
            _rr: dict[str, Any] = {}

            def _snapshot(n=name, holder=_rr):
                s = account_tools.get_bucket_config_snapshot(conn, provider_id, n)
                holder["raw"] = s.pop("_raw_reads", None)
                return s

            snap = run_tool_with_events(
                conn, run_id, "get_bucket_config_snapshot",
                {"provider_id": provider_id, "bucket": name}, _snapshot,
            )
            raw_reads = _rr.get("raw")  # reuse, never persisted
            ev = run_tool_with_events(
                conn, run_id, "discover_evidence_sources",
                {"provider_id": provider_id, "bucket": name},
                lambda n=name, rr=raw_reads: account_tools.discover_evidence_sources(
                    conn, provider_id, n, pre_reads=rr),
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
            elif head == account_tools.REGION_MISMATCH:
                # Exists but in another region — reachable with the right region,
                # NOT an error; surface distinctly so it isn't dropped as broken.
                access_status = account_tools.REGION_MISMATCH
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
        # Persistence is ISOLATED per-bucket too: a redact/json error on one
        # bucket's row must not abort the whole survey (the docstring promises it
        # continues). Previously these inserts sat outside the try above, so one
        # bad row failed the entire run.
        try:
            account_repo.add_bucket(conn, snapshot_id, run_id, provider_id, name,
                                    bucket_entry.get("region"), bucket_entry["access_status"])
            account_repo.add_config_snapshot(conn, snapshot_id, run_id, provider_id, name, bucket_entry)
            for src in bucket_entry.get("evidence_sources", []):
                account_repo.add_evidence_source(conn, snapshot_id, run_id, provider_id, name, src)
            conn.commit()
        except Exception as exc:  # noqa: BLE001 - per-bucket persistence isolation
            conn.rollback()
            bus.publish(run_id, {"type": "finding", "severity": "warning",
                                 "title": f"Bucket {name}: persistence error",
                                 "detail": redact_text(str(exc))})

    summary = _build_summary(per_bucket, visible, len(per_bucket), truncated)
    # Persist the computed summary onto the snapshot row.
    conn.execute(
        "UPDATE account_snapshots SET summary_json_sanitized = ? WHERE id = ?",
        (json.dumps(summary), snapshot_id),
    )
    conn.commit()

    # A few account-level findings (bounded; no per-object detail).
    # Public exposure FIRST — the account's most critical fact must never be
    # discovered, persisted, and then silently dropped from the narration.
    if summary["public_bucket_count"]:
        names = ", ".join(summary["public_buckets"][:10])
        more = summary["public_bucket_count"] - min(10, summary["public_bucket_count"])
        bus.publish(run_id, {"type": "finding", "severity": "critical",
                             "title": "PUBLIC buckets detected",
                             "detail": (f"{summary['public_bucket_count']} bucket(s) are publicly "
                                        f"exposed (policy verdict and/or ACL grants): {names}"
                                        + (f" (+{more} more)" if more > 0 else "") + ". "
                                        "Review each with review_bucket_security.")})
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
    public_note = (
        f" PUBLIC EXPOSURE: {summary['public_bucket_count']} bucket(s) publicly exposed"
        f" ({', '.join(summary['public_buckets'][:5])}"
        f"{'…' if summary['public_bucket_count'] > 5 else ''})."
        if summary["public_bucket_count"] else " No publicly exposed buckets detected."
    )
    summary_text = (
        f"Account discovery via provider '{provider_id}': {visible} bucket(s) visible, "
        f"{len(per_bucket)} processed{' (truncated)' if truncated else ''}. "
        f"Access status: " + (", ".join(f"{n} {s}" for s, n in counts.items()) or "—") + "."
        + public_note
    )
    bus.publish(run_id, {"type": "summary", "content": summary_text})

    profile = {
        "run_id": run_id, "provider_id": provider_id, "bucket_count": visible,
        "visible_count": visible, "processed_count": len(per_bucket),
        "truncated": truncated, "list_status": list_status,
        "summary": summary, "buckets": per_bucket,
    }
    content = render_account_profile(run, profile, summary_text)
    require_success(run_tool_with_events(
        conn, run_id, "generate_markdown_report", {"run_id": run_id},
        lambda: {"report_path": config.rel_path(write(run_id, content)), "format": "markdown"},
    ))
    return summary_text
