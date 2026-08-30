"""Deterministic cross-evidence correlation.

Joins already-sanitized aggregates from inventory, access logs, bucket config,
diagnostics, multipart/version listings, and endpoint/addressing probes into
bounded findings. Raw rows never enter this module; the output is the same
shape the summary builder already persists (title / severity / interpretation /
bounded evidence), so it flows through existing findings/memory channels.

This is not a second Agent. It runs inside the deterministic summary rebuild.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..security.redaction import redact_text

_MAX_FINDINGS = 12
_LABEL = 200


def _clip(value: Any, n: int = _LABEL) -> str:
    return redact_text(str(value or ""))[:n]


def _load(raw: Any) -> dict[str, Any]:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _finding(*, title: str, interpretation: str, severity: str = "info",
             evidence: dict[str, Any] | None = None,
             category: str = "correlation") -> dict[str, Any]:
    return {
        "source_run_id": None,
        "category": category,
        "severity": severity,
        "confidence": "high" if severity in ("error", "warning", "critical") else "medium",
        "kind": "inference",
        "title": redact_text(title)[:300],
        "interpretation": redact_text(interpretation)[:600],
        "evidence": evidence or {"kind": "cross_evidence_aggregate"},
    }


def _tool_outputs(conn: sqlite3.Connection, session_id: str) -> list[tuple[str, dict[str, Any]]]:
    """Sanitized tool outputs for this task: session-scoped agent calls plus
    linked deterministic runs. Bounded; parse failures skip the row."""
    out: list[tuple[str, dict[str, Any]]] = []
    rows = conn.execute(
        "SELECT tool_name, output_json_sanitized FROM tool_calls "
        "WHERE session_id = ? ORDER BY rowid DESC LIMIT 400",
        (session_id,),
    ).fetchall()
    run_rows = conn.execute(
        "SELECT tc.tool_name, tc.output_json_sanitized FROM tool_calls tc "
        "JOIN session_runs sr ON sr.run_id = tc.run_id "
        "WHERE sr.session_id = ? ORDER BY tc.rowid DESC LIMIT 400",
        (session_id,),
    ).fetchall()
    seen: set[tuple[str, str]] = set()
    for row in list(rows) + list(run_rows):
        name = str(row["tool_name"] or "")
        raw = row["output_json_sanitized"] or ""
        key = (name, raw[:200])
        if key in seen:
            continue
        seen.add(key)
        data = _load(raw)
        if data:
            out.append((name, data))
    return out


def collect_snapshot(outputs: list[tuple[str, dict[str, Any]]]) -> dict[str, Any]:
    """Fold tool outputs into a compact cross-evidence snapshot.

    Lists are last-write-wins per tool family so a later probe outranks an
    earlier one; findings lists accumulate (bounded).
    """
    snap: dict[str, Any] = {
        "inventory": None,
        "access_logs": None,
        "lifecycle": None,
        "security": None,
        "cost": None,
        "credentials": None,
        "head_bucket": None,
        "multipart": None,
        "versions": None,
        "config_findings": [],
        "addressing": None,
    }
    for name, data in reversed(outputs):  # oldest first so later wins
        metrics = data.get("metrics") if isinstance(data.get("metrics"), dict) else data
        if name in ("analyze_inventory", "analyze_uploaded_file") and (
                data.get("type") == "inventory" or "object_count" in metrics or "storage_class_distribution" in metrics):
            if data.get("type") == "inventory" or "object_count" in (data.get("metrics") or data):
                snap["inventory"] = data.get("metrics") or metrics
        if name in ("analyze_access_logs", "analyze_uploaded_file") and (
                data.get("type") == "access_log" or "total_requests" in metrics or "error_rate_4xx" in metrics):
            snap["access_logs"] = data.get("metrics") or metrics
        if name == "review_bucket_lifecycle":
            snap["lifecycle"] = data
            snap["config_findings"].extend(data.get("findings") or [])
        if name == "review_bucket_security":
            snap["security"] = data
            snap["config_findings"].extend(data.get("findings") or [])
        if name == "review_bucket_cost_optimization":
            snap["cost"] = data
            snap["config_findings"].extend(data.get("findings") or [])
        if name == "get_bucket_config_detail":
            snap["config_findings"].extend(data.get("findings") or [])
            facts = data.get("facts") if isinstance(data.get("facts"), dict) else {}
            if facts.get("lifecycle_status") or data.get("aspect") == "lifecycle":
                snap["lifecycle"] = snap["lifecycle"] or data
        if name == "test_credentials":
            snap["credentials"] = data
        if name == "head_bucket":
            snap["head_bucket"] = data
        if name in ("list_multipart_uploads",):
            snap["multipart"] = data
        if name in ("list_object_versions",):
            snap["versions"] = data
        if "endpoint" in name or "addressing" in name or name in (
                "diagnose_tls", "diagnose_endpoint"):
            snap["addressing"] = data
    snap["config_findings"] = snap["config_findings"][:40]
    return snap


def _titles(findings: list[dict[str, Any]]) -> str:
    return " ".join(_clip(f.get("title"), 80) for f in findings).lower()


def correlate_snapshot(snap: dict[str, Any]) -> list[dict[str, Any]]:
    """Pure correlation over a collected snapshot. Unit-testable without SQLite."""
    out: list[dict[str, Any]] = []
    logs = snap.get("access_logs") or {}
    inv = snap.get("inventory") or {}
    lifecycle = snap.get("lifecycle") or {}
    lc_facts = lifecycle.get("facts") if isinstance(lifecycle.get("facts"), dict) else lifecycle
    creds = snap.get("credentials") or {}
    head = snap.get("head_bucket") or {}
    multipart = snap.get("multipart") or {}
    versions = snap.get("versions") or {}
    cfg_titles = _titles(snap.get("config_findings") or [])

    error_4xx = float(logs.get("error_rate_4xx") or 0)
    error_5xx = float(logs.get("error_rate_5xx") or 0)
    share_403 = float(logs.get("share_403") or 0)
    share_404 = float(logs.get("share_404") or 0)
    creds_ok = creds.get("success")
    head_ok = head.get("success")
    head_status = head.get("status_code") or head.get("status")

    # 1. Request errors × bucket config × endpoint/addressing
    if share_403 >= 0.1 or error_4xx >= 0.1:
        if creds_ok is False or (head_ok is False and head_status in (403, 401, "403", "401")):
            out.append(_finding(
                title="Access errors line up with credential/addressing failure",
                severity="error",
                interpretation=(
                    f"Access-log 403 share is {share_403:.0%} (4xx {error_4xx:.0%}) and the "
                    "credential or HeadBucket probe did not succeed. Treat this as an "
                    "endpoint/key/scope problem, not a workload spike."
                ),
                evidence={"share_403": share_403, "error_rate_4xx": error_4xx,
                          "credentials_success": creds_ok, "head_bucket_success": head_ok,
                          "head_status": head_status},
            ))
        elif "public" in cfg_titles or "policy" in cfg_titles or "access denied" in cfg_titles:
            out.append(_finding(
                title="Request 403s correlate with bucket policy/PAB findings",
                severity="warning",
                interpretation=(
                    f"Access-log 403 share is {share_403:.0%} and bucket-config review "
                    "already flagged policy or public-access block issues. The log pattern "
                    "and the config finding describe the same access boundary."
                ),
                evidence={"share_403": share_403, "config_signal": True},
            ))
        elif creds_ok is True and head_ok is True and share_403 >= 0.2:
            out.append(_finding(
                title="403s persist while the probe path is healthy",
                severity="warning",
                interpretation=(
                    "Credentials and HeadBucket succeeded, but access logs still show a "
                    f"high 403 share ({share_403:.0%}). The denials are likely object/prefix "
                    "ACL or policy conditions the bounded probe did not exercise."
                ),
                evidence={"share_403": share_403, "credentials_success": True,
                          "head_bucket_success": True},
            ))
    if share_404 >= 0.2 and head_ok is False:
        out.append(_finding(
            title="404 pattern with a failed bucket probe",
            severity="warning",
            interpretation=(
                f"Access-log 404 share is {share_404:.0%} and HeadBucket did not succeed. "
                "Confirm the bucket name, region, and addressing style before treating "
                "the 404s as missing objects."
            ),
            evidence={"share_404": share_404, "head_bucket_success": head_ok},
        ))
    if error_5xx >= 0.05 and snap.get("addressing"):
        addr = snap["addressing"]
        if addr.get("success") is False or addr.get("ok") is False:
            out.append(_finding(
                title="5xx errors correlate with endpoint/TLS diagnosis failure",
                severity="error",
                interpretation=(
                    f"Access-log 5xx rate is {error_5xx:.0%} and an endpoint/TLS/"
                    "addressing probe failed. Investigate the configured endpoint "
                    "before attributing 5xx to the bucket workload."
                ),
                evidence={"error_rate_5xx": error_5xx, "addressing_success": addr.get("success")},
            ))

    # 2. Lifecycle rules × inventory age / storage class
    age = {a.get("bucket"): int(a.get("count") or 0)
           for a in (inv.get("object_age_distribution") or []) if isinstance(a, dict)}
    object_count = int(inv.get("object_count") or 0)
    old = age.get("365d+", 0)
    old_ratio = (old / object_count) if object_count else 0.0
    storage = inv.get("storage_class_distribution") or []
    standard_share = 0.0
    if object_count and storage:
        std = sum(int(s.get("count") or 0) for s in storage
                  if str(s.get("value") or "").upper() in ("STANDARD", "STANDARD_IA", ""))
        # Prefer explicit STANDARD
        std = sum(int(s.get("count") or 0) for s in storage
                  if str(s.get("value") or "").upper() == "STANDARD")
        standard_share = std / object_count
    lc_status = lc_facts.get("lifecycle_status") or lifecycle.get("lifecycle_status")
    has_transition = bool(lc_facts.get("has_transition"))
    has_expiration = bool(lc_facts.get("has_expiration"))
    no_lifecycle = lc_status in ("not_configured", "NotConfigured", None) and lifecycle
    if object_count and old_ratio >= 0.3:
        if no_lifecycle or lc_status == "not_configured" or (
                lifecycle and not has_expiration and not has_transition):
            out.append(_finding(
                title="Aged inventory without covering lifecycle rules",
                severity="info",
                interpretation=(
                    f"{old_ratio:.0%} of inventoried objects are older than 365 days, "
                    "and lifecycle review did not show expiration or transition rules "
                    "covering them. This is a cost/retention gap, not a mutation."
                ),
                evidence={"old_ratio": round(old_ratio, 4), "object_count": object_count,
                          "lifecycle_status": lc_status,
                          "has_expiration": has_expiration, "has_transition": has_transition},
            ))
        elif has_transition and standard_share >= 0.8 and old_ratio >= 0.3:
            out.append(_finding(
                title="Lifecycle transitions are not visible in storage-class mix",
                severity="info",
                interpretation=(
                    f"Lifecycle reports transition rules, but {standard_share:.0%} of "
                    f"inventoried objects are still STANDARD and {old_ratio:.0%} are "
                    "older than 365 days. The rules may not match these prefixes, or "
                    "they have not taken effect yet."
                ),
                evidence={"standard_share": round(standard_share, 4),
                          "old_ratio": round(old_ratio, 4), "has_transition": True},
            ))

    # 3. Multipart / version pile-up × cost
    uploads = multipart.get("uploads") or multipart.get("items") or []
    upload_count = multipart.get("upload_count") or multipart.get("key_count") or len(uploads)
    try:
        upload_count = int(upload_count or 0)
    except (TypeError, ValueError):
        upload_count = len(uploads) if isinstance(uploads, list) else 0
    has_abort_mpu = bool(lc_facts.get("has_abort_mpu"))
    if upload_count >= 5 and (no_lifecycle or not has_abort_mpu):
        out.append(_finding(
            title="Incomplete multipart uploads without abort lifecycle",
            severity="warning",
            interpretation=(
                f"{upload_count} incomplete multipart upload(s) were listed and "
                "lifecycle has no AbortIncompleteMultipartUpload rule. Abandoned "
                "parts continue to accrue cost until expired."
            ),
            evidence={"upload_count": upload_count, "has_abort_mpu": has_abort_mpu},
        ))
    versioning_on = bool(lc_facts.get("versioning_enabled") or versions.get("versioning_enabled"))
    version_count = versions.get("key_count") or versions.get("version_count") or len(
        versions.get("versions") or versions.get("items") or [])
    try:
        version_count = int(version_count or 0)
    except (TypeError, ValueError):
        version_count = 0
    has_noncurrent = bool(lc_facts.get("has_noncurrent_expiration"))
    if versioning_on and version_count >= 50 and not has_noncurrent:
        out.append(_finding(
            title="Version pile-up without noncurrent expiration",
            severity="warning",
            interpretation=(
                f"Versioning is on and a bounded listing showed {version_count} "
                "version row(s), with no noncurrent-version expiration rule. "
                "Noncurrent versions accumulate storage cost."
            ),
            evidence={"version_count": version_count, "versioning_enabled": True,
                      "has_noncurrent_expiration": False},
        ))
    cost_titles = _titles((snap.get("cost") or {}).get("findings") or [])
    if upload_count >= 5 and ("multipart" in cost_titles or "incomplete" in cost_titles):
        out.append(_finding(
            title="Multipart residue matches the cost-review finding",
            severity="info",
            interpretation=(
                "Incomplete multipart listings and the cost-optimization review "
                "both point at abandoned upload residue. One confirmation-gated "
                "lifecycle change would address both signals."
            ),
            evidence={"upload_count": upload_count, "cost_review": True},
        ))

    # 4. Access-log request mix × latency / error patterns
    lat = logs.get("latency") if isinstance(logs.get("latency"), dict) else {}
    p95 = float(lat.get("p95_ms") or 0)
    p50 = float(lat.get("p50_ms") or 0)
    measured = int(lat.get("measured_requests") or 0)
    methods = logs.get("method_distribution") or logs.get("methods") or []
    put_share = 0.0
    get_share = 0.0
    total_req = int(logs.get("total_requests") or 0)
    if total_req and isinstance(methods, list):
        for m in methods:
            label = str(m.get("value") or m.get("method") or "").upper()
            n = int(m.get("count") or 0)
            if label in ("PUT", "POST"):
                put_share += n / total_req
            if label == "GET":
                get_share += n / total_req
    range_share = float(logs.get("range_share_206") or 0)
    if measured >= 50 and p95 >= 500 and p50 > 0 and p95 >= 8 * p50:
        if put_share >= 0.3:
            out.append(_finding(
                title="Write-heavy mix with a long latency tail",
                severity="warning",
                interpretation=(
                    f"PUT/POST are {put_share:.0%} of requests and p95 latency is "
                    f"{p95:.0f} ms against p50 {p50:.0f} ms. The tail is consistent "
                    "with ingest/multipart pressure rather than a uniform slow bucket."
                ),
                evidence={"put_post_share": round(put_share, 4), "p95_ms": p95, "p50_ms": p50},
            ))
        elif range_share >= 0.3:
            out.append(_finding(
                title="Range reads dominate a long latency tail",
                severity="info",
                interpretation=(
                    f"206 Partial Content is {range_share:.0%} of requests and p95 "
                    f"is {p95:.0f} ms. Large-object or cold-storage range reads are "
                    "a better first explanation than a generic endpoint fault."
                ),
                evidence={"range_share_206": range_share, "p95_ms": p95, "p50_ms": p50},
            ))
        elif share_404 >= 0.15 and get_share >= 0.5:
            out.append(_finding(
                title="GET-heavy 404s sit on the latency tail",
                severity="warning",
                interpretation=(
                    f"GETs are {get_share:.0%} of traffic, 404 share is {share_404:.0%}, "
                    f"and p95 is {p95:.0f} ms. Missing keys / wrong prefix are a better "
                    "fit than capacity, and the tail may include retries of those 404s."
                ),
                evidence={"get_share": round(get_share, 4), "share_404": share_404,
                          "p95_ms": p95},
            ))
    return out[:_MAX_FINDINGS]


def correlate(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    """Load this task's sanitized tool outputs and emit cross-evidence findings."""
    try:
        outputs = _tool_outputs(conn, session_id)
    except Exception:  # noqa: BLE001 — correlation must never fail summary rebuild
        return []
    return correlate_snapshot(collect_snapshot(outputs))
