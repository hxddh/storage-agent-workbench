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
import time
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
# Per-bucket probing is network-bound (a dozen-ish S3 round trips per bucket) and
# was fully serial, so a 100-bucket account paid 100 x latency end to end. Only
# the PROBES are parallelized; every database write stays on the run thread (see
# the loop below). Kept deliberately small: this is one user's desktop app
# talking to one account, and a wide fan-out invites provider-side throttling
# (SlowDown), which would make the survey slower AND noisier, not faster.
_PROBE_WORKERS = 4
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


def _undetermined(buckets: list[dict[str, Any]], field: str) -> list[str]:
    """Buckets whose status on this dimension was never established — the read
    was denied, errored, or the field was never written.

    ``provider_unsupported`` is counted separately (the provider genuinely has no
    such feature, which IS an answer); everything here is "we do not know". The
    per-dimension tallies used to report only configured/not_configured (+
    unsupported for some), so on an account where GetBucketEncryption is denied
    the numbers quietly failed to add up to the bucket count and "1 bucket has
    no default encryption" read as a verdict on all of them."""
    return [b["bucket_name"] for b in buckets
            if b.get(field) not in (_CONFIGURED, _NOT_CONFIGURED, _UNSUPPORTED)]


def _replay(probe: dict[str, Any], which: str) -> dict[str, Any]:
    """Hand back a probe's finished result, or re-raise how it failed.

    Re-raising matters: ``run_tool`` turns an executor exception into the
    recorded error row, so a probe that blew up produces exactly the tool_call
    it produced when the work ran inline."""
    exc = probe.get(f"{which}_exc")
    if exc is not None:
        raise exc
    return probe[which]


def _probe_buckets(provider_id: str, names: list[str]) -> dict[str, dict[str, Any]]:
    """Run every bucket's read-only probes in a bounded pool, keyed by name.

    ONLY network work happens here. Each worker opens its OWN sqlite connection
    — ``account_tools`` uses it purely to read the provider row and build the
    (globally cached, request-thread-safe) boto3 client, never to write — so the
    run's own connection is untouched and no database write is ever concurrent.
    Failures are captured per bucket and re-raised on the run thread, keeping the
    executor's per-bucket isolation exactly as it was.
    """
    from concurrent.futures import ThreadPoolExecutor

    from ..db import connect

    def _one(name: str) -> dict[str, Any]:
        out: dict[str, Any] = {}
        wconn = connect()
        try:
            started = time.monotonic()
            try:
                snap = account_tools.get_bucket_config_snapshot(wconn, provider_id, name)
                # Strip the raw reads HERE so the recorded snapshot never carries
                # them (rule: raw logging/inventory reads are reused, never
                # persisted); keep them in-memory to feed evidence discovery.
                raw_reads = snap.pop("_raw_reads", None)
                out["snapshot"] = snap
            except Exception as exc:  # noqa: BLE001 - re-raised on the run thread
                out["snapshot_exc"] = exc
                raw_reads = None
            out["snapshot_ms"] = int((time.monotonic() - started) * 1000)

            started = time.monotonic()
            try:
                out["evidence"] = account_tools.discover_evidence_sources(
                    wconn, provider_id, name, pre_reads=raw_reads)
            except Exception as exc:  # noqa: BLE001 - re-raised on the run thread
                out["evidence_exc"] = exc
            out["evidence_ms"] = int((time.monotonic() - started) * 1000)
        finally:
            wconn.close()
        return out

    if len(names) <= 1:
        return {n: _one(n) for n in names}
    with ThreadPoolExecutor(max_workers=min(_PROBE_WORKERS, len(names))) as pool:
        return dict(zip(names, pool.map(_one, names)))


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
    # …and the buckets where the question could not be ANSWERED. `account_tools`
    # already models this honestly: `publicly_exposed` is None when the policy
    # and ACL probes did not both yield a verdict. Collapsing that into the
    # "none detected" branch is how a minimal S3-compatible endpoint (MinIO,
    # Ceph, garage — the systems this product exists for, which answer 501 to
    # most config sub-resources) and an AWS credential without
    # `s3:GetBucketPolicyStatus` both got told their buckets are not public.
    exposure_unknown = names_where(
        lambda b: b.get("publicly_exposed") is None and b.get("policy_is_public") is not True
    )
    needs_review = names_where(
        lambda b: b.get("encryption_status") == _NOT_CONFIGURED
        or b.get("public_access_block_status") == _NOT_CONFIGURED
        or b.get("publicly_exposed") is True
        or b.get("policy_is_public") is True
    )
    access_denied = names_where(lambda b: b.get("access_status") == _DENIED)
    errored = names_where(lambda b: b.get("access_status") == "error")
    # Per dimension: configured + not_configured + unsupported + undetermined
    # must account for every processed bucket, so no tally can imply a verdict
    # over buckets whose read never landed. (`test_account_survey_tallies_*`
    # pins the arithmetic.)
    enc_unknown = _undetermined(buckets, "encryption_status")
    log_unknown = _undetermined(buckets, "logging_status")
    inv_unknown = _undetermined(buckets, "inventory_status")
    lc_unknown = _undetermined(buckets, "lifecycle_status")
    pab_unknown = _undetermined(buckets, "public_access_block_status")

    return {
        "public_buckets": public_buckets,
        "public_bucket_count": len(public_buckets),
        "exposure_unknown_buckets": exposure_unknown,
        "exposure_unknown_count": len(exposure_unknown),
        "acls_disabled_count": sum(1 for b in buckets if b.get("acls_disabled") is True),
        "visible_buckets": visible,
        "processed_buckets": processed,
        "truncated": truncated,
        "encryption_configured": _count(buckets, "encryption_status", _CONFIGURED),
        "encryption_not_configured": _count(buckets, "encryption_status", _NOT_CONFIGURED),
        "encryption_unsupported": _count(buckets, "encryption_status", _UNSUPPORTED),
        "encryption_undetermined": len(enc_unknown),
        "encryption_undetermined_buckets": enc_unknown,
        "logging_configured": _count(buckets, "logging_status", _CONFIGURED),
        "logging_not_configured": _count(buckets, "logging_status", _NOT_CONFIGURED),
        "logging_unsupported": _count(buckets, "logging_status", _UNSUPPORTED),
        "logging_undetermined": len(log_unknown),
        "inventory_configured": _count(buckets, "inventory_status", _CONFIGURED),
        "inventory_not_configured": _count(buckets, "inventory_status", _NOT_CONFIGURED),
        "inventory_unsupported": _count(buckets, "inventory_status", _UNSUPPORTED),
        "inventory_undetermined": len(inv_unknown),
        "lifecycle_configured": _count(buckets, "lifecycle_status", _CONFIGURED),
        "lifecycle_not_configured": _count(buckets, "lifecycle_status", _NOT_CONFIGURED),
        "lifecycle_unsupported": _count(buckets, "lifecycle_status", _UNSUPPORTED),
        "lifecycle_undetermined": len(lc_unknown),
        "public_access_block_configured": _count(buckets, "public_access_block_status", _CONFIGURED),
        "public_access_block_not_configured": _count(buckets, "public_access_block_status", _NOT_CONFIGURED),
        "public_access_block_unsupported": _count(buckets, "public_access_block_status", _UNSUPPORTED),
        "public_access_block_undetermined": len(pab_unknown),
        "buckets_with_inventory_evidence": with_inventory,
        "buckets_with_logging_evidence": with_logging,
        "buckets_needing_review": needs_review,
        "access_denied_buckets": access_denied,
        "error_buckets": errored,
    }


def exposure_note(summary: dict[str, Any]) -> str:
    """The survey's public-exposure sentence — THREE outcomes, not two.

    This is the highest-stakes thing the survey says. It is not a UI string: it
    lands in the run's ``final_summary``, the agent reads it, and the agent
    narrates it to the user as a security conclusion.

    It used to be binary — exposed, or "No publicly exposed buckets detected" —
    so a bucket whose policy/ACL probes never ANSWERED fell into the reassuring
    branch. That is the normal case for a minimal S3-compatible endpoint (MinIO,
    Ceph, garage answer 501 to most config sub-resources) and for a
    least-privilege AWS role without ``s3:GetBucketPolicyStatus``. Both were
    told their buckets are not public, on the strength of a check that never
    ran.

    "I checked and nothing is exposed" and "I could not check" are different
    facts, and only one of them is reassuring. Rule 18: a capability gap is
    reported, never silently resolved.
    """
    unknown_n = summary.get("exposure_unknown_count") or 0
    unknown_note = (
        f" Public exposure UNDETERMINED for {unknown_n} bucket(s)"
        f" ({', '.join(summary['exposure_unknown_buckets'][:5])}"
        f"{'…' if unknown_n > 5 else ''}) — the endpoint did not answer the"
        " policy/ACL checks (unsupported or denied), so this is not a clean bill of health."
        if unknown_n else ""
    )
    if summary.get("public_bucket_count"):
        # The severe fact leads, but a remaining gap is not swallowed by it:
        # fixing the named bucket must not look like fixing the account.
        return (
            f" PUBLIC EXPOSURE: {summary['public_bucket_count']} bucket(s) publicly exposed"
            f" ({', '.join(summary['public_buckets'][:5])}"
            f"{'…' if summary['public_bucket_count'] > 5 else ''})." + unknown_note
        )
    if unknown_n:
        return unknown_note
    return " No publicly exposed buckets detected."


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

    probes = _probe_buckets(provider_id, selected)

    per_bucket: list[dict[str, Any]] = []
    for name in selected:
        access_status = _CONFIGURED
        probe = probes[name]
        try:
            # The network work already happened in the bounded pool above; these
            # callables just hand back its result (or re-raise its failure, so
            # run_tool records the same error row it always did). Recording stays
            # SEQUENTIAL and in `selected` order, so tool_call/audit rows, SSE
            # event order, and the per-bucket transaction isolation below are all
            # byte-for-byte what they were when the probes ran inline. The real
            # elapsed time is passed through so the audit row isn't a ~0 ms lie.
            #
            # `_raw_reads` was already stripped inside the probe, so the recorded
            # snapshot never carries the raw logging/inventory reads.
            snap = run_tool_with_events(
                conn, run_id, "get_bucket_config_snapshot",
                {"provider_id": provider_id, "bucket": name},
                lambda p=probe: _replay(p, "snapshot"),
                duration_ms=probe.get("snapshot_ms"),
            )
            ev = run_tool_with_events(
                conn, run_id, "discover_evidence_sources",
                {"provider_id": provider_id, "bucket": name},
                lambda p=probe: _replay(p, "evidence"),
                duration_ms=probe.get("evidence_ms"),
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
    if summary["exposure_unknown_count"]:
        names = ", ".join(summary["exposure_unknown_buckets"][:5])
        more = summary["exposure_unknown_count"] - 5
        bus.publish(run_id, {"type": "finding", "severity": "warning",
                             "title": "Public exposure could not be determined",
                             "detail": (f"{summary['exposure_unknown_count']} bucket(s) did not answer "
                                        f"the policy/ACL exposure checks: {names}"
                                        + (f" (+{more} more)" if more > 0 else "") + ". "
                                        "The provider may not support them, or the credentials may "
                                        "lack permission. This is NOT the same as 'not public'.")})
    if summary["encryption_not_configured"]:
        # Say what the count covers. "3 buckets have no default encryption" over
        # an account where 8 more were never readable is a verdict on 11.
        est = (len(per_bucket) - summary["encryption_undetermined"])
        bus.publish(run_id, {"type": "finding", "severity": "warning",
                             "title": "Buckets without default encryption",
                             "detail": (f"{summary['encryption_not_configured']} bucket(s) have no "
                                        f"default encryption, out of {est} whose encryption was "
                                        f"established (of {len(per_bucket)} processed).")})
    if summary["encryption_undetermined"]:
        names = ", ".join(summary["encryption_undetermined_buckets"][:5])
        more = summary["encryption_undetermined"] - 5
        bus.publish(run_id, {"type": "finding", "severity": "warning",
                             "title": "Encryption could not be determined",
                             "detail": (f"{summary['encryption_undetermined']} bucket(s) did not answer "
                                        f"the default-encryption check: {names}"
                                        + (f" (+{more} more)" if more > 0 else "") + ". "
                                        "The credentials may lack permission, or the read errored. "
                                        "This is NOT the same as 'encrypted'.")})
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
    public_note = exposure_note(summary)
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
