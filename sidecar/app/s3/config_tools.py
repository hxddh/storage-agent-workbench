"""Read-only bucket configuration review tools (Phase 06).

Every function here uses ONLY read-only S3 APIs (``get_*`` / ``list_*``). There
is no put/delete/create/update of any kind, no auto-remediation, and no object
body download. For S3-compatible providers that do not implement an API, the
result is surfaced as ``provider_unsupported`` rather than failing the run.

Outputs are structured *facts* and *findings* — never raw bucket policy text,
account IDs, ARNs, credentials, or signatures.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from botocore.exceptions import ClientError

from . import client_factory

PERF_MAX_KEYS = 100
SAMPLE_LIMIT = 20
SMALL_OBJECT_BYTES = 1024 * 1024

# Read status vocabulary.
AVAILABLE = "available"
NOT_CONFIGURED = "not_configured"
PROVIDER_UNSUPPORTED = "provider_unsupported"
ACCESS_DENIED = "access_denied"
ERROR = "error"

# Finding categories.
CRITICAL = "Critical"
WARNING = "Warning"
OPPORTUNITY = "Opportunity"
GOOD = "Good"
NOT_APPLICABLE = "Not applicable"
PROVIDER_UNSUPPORTED_CAT = "Provider unsupported"

_NOT_CONFIGURED_CODES = {
    "NoSuchLifecycleConfiguration",
    "NoSuchBucketPolicy",
    "NoSuchCORSConfiguration",
    "ServerSideEncryptionConfigurationNotFoundError",
    "ReplicationConfigurationNotFoundError",
    "NoSuchPublicAccessBlockConfiguration",
    "NoSuchTagSet",
    "NoSuchTagSetError",
    "NoSuchConfiguration",
    "NoSuchWebsiteConfiguration",
}
_UNSUPPORTED_CODES = {"NotImplemented", "MethodNotAllowed", "NotSupported", "Unsupported"}
_DENIED_CODES = {"AccessDenied", "Forbidden", "AllAccessDisabled", "UnauthorizedAccess"}

_AllUsers = "http://acs.amazonaws.com/groups/global/AllUsers"


def _read(client, method: str, **kwargs) -> dict[str, Any]:
    """Call a read-only client method, mapping failures to a structured status."""
    try:
        resp = getattr(client, method)(**kwargs)
        return {"status": AVAILABLE, "data": resp}
    except ClientError as exc:
        err = exc.response.get("Error", {}) if exc.response else {}
        code = err.get("Code")
        http = (exc.response or {}).get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in _NOT_CONFIGURED_CODES:
            status = NOT_CONFIGURED
        elif code in _UNSUPPORTED_CODES or http == 501:
            status = PROVIDER_UNSUPPORTED
        elif code in _DENIED_CODES or http == 403:
            status = ACCESS_DENIED
        else:
            status = ERROR
        return {"status": status, "error_code": code}
    except Exception as exc:  # noqa: BLE001 - structured, not raised
        return {"status": ERROR, "error_code": type(exc).__name__}


def _finding(category: str, title: str, detail: str) -> dict[str, str]:
    return {"category": category, "title": title, "detail": detail}


# --- 1. get_bucket_config_summary -------------------------------------------

_CONFIG_READS = [
    ("location", "get_bucket_location"),
    ("versioning", "get_bucket_versioning"),
    ("lifecycle", "get_bucket_lifecycle_configuration"),
    ("encryption", "get_bucket_encryption"),
    ("logging", "get_bucket_logging"),
    ("policy", "get_bucket_policy"),
    ("cors", "get_bucket_cors"),
    ("acl", "get_bucket_acl"),
    ("public_access_block", "get_public_access_block"),
    ("replication", "get_bucket_replication"),
    ("notification", "get_bucket_notification_configuration"),
    ("tagging", "get_bucket_tagging"),
]


def get_bucket_config_summary(conn: sqlite3.Connection, provider_id: str, bucket: str) -> dict[str, Any]:
    cfg = client_factory.load_provider(conn, provider_id)
    client = client_factory.build_s3_client(conn, provider_id)

    config_items: dict[str, str] = {}
    for name, method in _CONFIG_READS:
        config_items[name] = _read(client, method, Bucket=bucket)["status"]

    provider_unsupported_items = [n for n, s in config_items.items() if s == PROVIDER_UNSUPPORTED]
    access_denied_items = [n for n, s in config_items.items() if s == ACCESS_DENIED]
    available = [n for n, s in config_items.items() if s == AVAILABLE]

    findings: list[dict[str, str]] = []
    for item in provider_unsupported_items:
        findings.append(_finding(PROVIDER_UNSUPPORTED_CAT, f"{item} not supported by provider",
                                 "This S3-compatible provider does not implement the API."))
    for item in access_denied_items:
        findings.append(_finding(WARNING, f"Access denied reading {item}",
                                 "The credentials lack permission to read this configuration."))
    if available:
        findings.append(_finding(GOOD, "Configuration readable",
                                 f"Read {len(available)} configuration item(s) successfully."))

    if access_denied_items:
        overall = "partial_access"
    elif len(provider_unsupported_items) >= len(_CONFIG_READS) - 1:
        overall = "provider_limited"
    else:
        overall = "reviewed"

    counts: dict[str, int] = {}
    for f in findings:
        counts[f["category"]] = counts.get(f["category"], 0) + 1

    return {
        "success": True,
        "bucket": bucket,
        "provider_id": provider_id,
        "endpoint_url": cfg.endpoint_url,
        "region": cfg.region,
        "config_items": config_items,
        "findings_count_by_category": counts,
        "provider_unsupported_items": provider_unsupported_items,
        "access_denied_items": access_denied_items,
        "overall_status": overall,
        "findings": findings,
    }


# --- helpers for parsing (no secrets/IDs leave these) -----------------------


def _policy_facts(policy_read: dict[str, Any]) -> dict[str, Any]:
    """Extract boolean facts from a bucket policy without exposing the raw doc."""
    facts = {"public_principal": False, "anonymous_get_object": False, "anonymous_list_bucket": False}
    if policy_read["status"] != AVAILABLE:
        return facts
    try:
        doc = json.loads(policy_read["data"].get("Policy", "{}"))
    except (json.JSONDecodeError, AttributeError):
        return facts
    for stmt in doc.get("Statement", []) or []:
        if stmt.get("Effect") != "Allow":
            continue
        principal = stmt.get("Principal")
        is_public = principal == "*" or (isinstance(principal, dict) and "*" in str(principal.get("AWS", "")))
        if not is_public:
            continue
        facts["public_principal"] = True
        actions = stmt.get("Action", [])
        actions = [actions] if isinstance(actions, str) else actions
        actions_l = [a.lower() for a in actions]
        if any(a in ("s3:getobject", "s3:*", "*") for a in actions_l):
            facts["anonymous_get_object"] = True
        if any(a in ("s3:listbucket", "s3:*", "*") for a in actions_l):
            facts["anonymous_list_bucket"] = True
    return facts


def _acl_public(acl_read: dict[str, Any]) -> bool:
    if acl_read["status"] != AVAILABLE:
        return False
    for grant in acl_read["data"].get("Grants", []) or []:
        grantee = grant.get("Grantee", {})
        if grantee.get("URI") == _AllUsers:
            return True
    return False


def _lifecycle_facts(lc_read: dict[str, Any]) -> dict[str, Any]:
    facts = {"has_rules": False, "has_abort_mpu": False, "has_expiration": False,
             "has_transition": False, "has_noncurrent_expiration": False}
    if lc_read["status"] != AVAILABLE:
        return facts
    rules = lc_read["data"].get("Rules", []) or []
    facts["has_rules"] = bool(rules)
    for r in rules:
        if r.get("AbortIncompleteMultipartUpload"):
            facts["has_abort_mpu"] = True
        if r.get("Expiration"):
            facts["has_expiration"] = True
        if r.get("Transitions") or r.get("Transition"):
            facts["has_transition"] = True
        if r.get("NoncurrentVersionExpiration"):
            facts["has_noncurrent_expiration"] = True
    return facts


def _versioning_enabled(v_read: dict[str, Any]) -> bool:
    return v_read["status"] == AVAILABLE and v_read["data"].get("Status") == "Enabled"


def _unsupported_findings(status: str, item: str) -> list[dict[str, str]]:
    if status == PROVIDER_UNSUPPORTED:
        return [_finding(PROVIDER_UNSUPPORTED_CAT, f"{item} not supported",
                         "Provider does not implement this configuration API.")]
    if status == ACCESS_DENIED:
        return [_finding(WARNING, f"Access denied reading {item}",
                         "Credentials lack permission to read this configuration.")]
    return []


# --- 2. review_bucket_security ----------------------------------------------


def review_bucket_security(conn: sqlite3.Connection, provider_id: str, bucket: str) -> dict[str, Any]:
    client = client_factory.build_s3_client(conn, provider_id)
    policy = _read(client, "get_bucket_policy", Bucket=bucket)
    cors = _read(client, "get_bucket_cors", Bucket=bucket)
    enc = _read(client, "get_bucket_encryption", Bucket=bucket)
    acl = _read(client, "get_bucket_acl", Bucket=bucket)
    pab = _read(client, "get_public_access_block", Bucket=bucket)

    pf = _policy_facts(policy)
    findings: list[dict[str, str]] = []

    if pf["public_principal"]:
        findings.append(_finding(WARNING, "Bucket policy allows a wildcard principal",
                                 "A statement allows Principal '*'. Confirm this is intentional."))
    if pf["anonymous_get_object"]:
        findings.append(_finding(CRITICAL, "Anonymous s3:GetObject allowed",
                                 "Policy permits unauthenticated object reads."))
    if pf["anonymous_list_bucket"]:
        findings.append(_finding(CRITICAL, "Anonymous s3:ListBucket allowed",
                                 "Policy permits unauthenticated bucket listing."))
    if policy["status"] == NOT_CONFIGURED and not pf["public_principal"]:
        findings.append(_finding(GOOD, "No bucket policy granting public access", "No bucket policy is set."))
    findings += _unsupported_findings(policy["status"], "bucket policy")

    cors_wildcard = False
    if cors["status"] == AVAILABLE:
        for rule in cors["data"].get("CORSRules", []) or []:
            if "*" in (rule.get("AllowedOrigins") or []):
                cors_wildcard = True
        if cors_wildcard:
            findings.append(_finding(WARNING, "CORS allows all origins",
                                     "A CORS rule uses AllowedOrigins ['*']."))
    findings += _unsupported_findings(cors["status"], "CORS")

    if enc["status"] == AVAILABLE:
        findings.append(_finding(GOOD, "Default encryption enabled", "Server-side default encryption is configured."))
    elif enc["status"] == NOT_CONFIGURED:
        findings.append(_finding(WARNING, "No default encryption", "Bucket has no default server-side encryption."))
    findings += _unsupported_findings(enc["status"], "encryption")

    acl_public = _acl_public(acl)
    if acl_public:
        findings.append(_finding(CRITICAL, "ACL grants public access",
                                 "Bucket ACL grants access to AllUsers (public)."))
    findings += _unsupported_findings(acl["status"], "ACL")

    pab_details: dict[str, bool] = {}
    if pab["status"] == AVAILABLE:
        cfgblk = pab["data"].get("PublicAccessBlockConfiguration", {})
        pab_details = {
            "BlockPublicAcls": bool(cfgblk.get("BlockPublicAcls")),
            "IgnorePublicAcls": bool(cfgblk.get("IgnorePublicAcls")),
            "BlockPublicPolicy": bool(cfgblk.get("BlockPublicPolicy")),
            "RestrictPublicBuckets": bool(cfgblk.get("RestrictPublicBuckets")),
        }
        if all(pab_details.values()):
            findings.append(_finding(GOOD, "Public access fully blocked", "All public access block settings are enabled."))
        else:
            findings.append(_finding(WARNING, "Public access block incomplete",
                                     "Not all public access block settings are enabled."))
    elif pab["status"] == NOT_CONFIGURED:
        findings.append(_finding(WARNING, "Public access block not configured",
                                 "No public access block configuration is set."))
    findings += _unsupported_findings(pab["status"], "public access block")

    return {
        "success": True,
        "facts": {
            "policy_status": policy["status"],
            "public_principal": pf["public_principal"],
            "anonymous_get_object": pf["anonymous_get_object"],
            "anonymous_list_bucket": pf["anonymous_list_bucket"],
            "cors_status": cors["status"],
            "cors_wildcard_origin": cors_wildcard,
            "encryption_status": enc["status"],
            "acl_status": acl["status"],
            "acl_public": acl_public,
            "public_access_block_status": pab["status"],
            "public_access_block": pab_details,
        },
        "findings": findings,
    }


# --- 3. review_bucket_lifecycle ---------------------------------------------


def review_bucket_lifecycle(conn: sqlite3.Connection, provider_id: str, bucket: str) -> dict[str, Any]:
    client = client_factory.build_s3_client(conn, provider_id)
    lc = _read(client, "get_bucket_lifecycle_configuration", Bucket=bucket)
    ver = _read(client, "get_bucket_versioning", Bucket=bucket)

    facts = _lifecycle_facts(lc)
    versioning_on = _versioning_enabled(ver)
    findings: list[dict[str, str]] = []

    if lc["status"] == NOT_CONFIGURED:
        findings.append(_finding(OPPORTUNITY, "No lifecycle configuration",
                                 "Consider lifecycle rules for expiration, transitions, and cleanup."))
    elif lc["status"] == AVAILABLE:
        if not facts["has_abort_mpu"]:
            findings.append(_finding(WARNING, "No AbortIncompleteMultipartUpload rule",
                                     "Incomplete multipart uploads can accumulate cost without cleanup."))
        if not facts["has_expiration"]:
            findings.append(_finding(OPPORTUNITY, "No expiration rules", "No object expiration rules are configured."))
        if not facts["has_transition"]:
            findings.append(_finding(OPPORTUNITY, "No transition rules", "No storage-class transition rules are configured."))
        if versioning_on and not facts["has_noncurrent_expiration"]:
            findings.append(_finding(WARNING, "Versioning enabled without noncurrent cleanup",
                                     "Noncurrent versions are never expired; they will accumulate."))
        if facts["has_abort_mpu"] and facts["has_expiration"]:
            findings.append(_finding(GOOD, "Lifecycle covers cleanup and expiration", "Lifecycle rules look reasonable."))
    findings += _unsupported_findings(lc["status"], "lifecycle")
    findings += _unsupported_findings(ver["status"], "versioning")

    return {
        "success": True,
        "facts": {"lifecycle_status": lc["status"], "versioning_enabled": versioning_on, **facts},
        "findings": findings,
    }


# --- 4. review_bucket_observability -----------------------------------------


def review_bucket_observability(conn: sqlite3.Connection, provider_id: str, bucket: str) -> dict[str, Any]:
    client = client_factory.build_s3_client(conn, provider_id)
    logging_r = _read(client, "get_bucket_logging", Bucket=bucket)
    notif = _read(client, "get_bucket_notification_configuration", Bucket=bucket)
    tagging = _read(client, "get_bucket_tagging", Bucket=bucket)

    findings: list[dict[str, str]] = []
    logging_enabled = logging_r["status"] == AVAILABLE and bool(logging_r["data"].get("LoggingEnabled"))
    if logging_r["status"] == AVAILABLE:
        if logging_enabled:
            findings.append(_finding(GOOD, "Server access logging enabled", "Access logging is configured."))
        else:
            findings.append(_finding(OPPORTUNITY, "Server access logging not enabled",
                                     "Enable access logging for audit and analysis."))
    findings += _unsupported_findings(logging_r["status"], "logging")

    notif_configured = False
    if notif["status"] == AVAILABLE:
        d = notif["data"]
        notif_configured = any(d.get(k) for k in (
            "TopicConfigurations", "QueueConfigurations", "LambdaFunctionConfigurations",
            "EventBridgeConfiguration"))
        if not notif_configured:
            findings.append(_finding(NOT_APPLICABLE, "No event notifications",
                                     "No notification targets are configured (may be intentional)."))
    findings += _unsupported_findings(notif["status"], "notification")

    has_tags = tagging["status"] == AVAILABLE and bool(tagging["data"].get("TagSet"))
    if tagging["status"] in (AVAILABLE, NOT_CONFIGURED) and not has_tags:
        findings.append(_finding(OPPORTUNITY, "No bucket tags", "Tags help with cost attribution and ownership."))
    findings += _unsupported_findings(tagging["status"], "tagging")

    # Inventory configuration API is out of scope for Phase 06.
    findings.append(_finding(NOT_APPLICABLE, "Inventory configuration not assessed",
                             "Bucket inventory configuration review is future work; run inventory_analysis on an "
                             "uploaded inventory file instead."))

    return {
        "success": True,
        "facts": {
            "logging_status": logging_r["status"],
            "logging_enabled": logging_enabled,
            "notification_status": notif["status"],
            "notification_configured": notif_configured,
            "tagging_status": tagging["status"],
            "has_tags": has_tags,
        },
        "findings": findings,
    }


# --- 5. review_bucket_cost_optimization -------------------------------------


def review_bucket_cost_optimization(conn: sqlite3.Connection, provider_id: str, bucket: str) -> dict[str, Any]:
    client = client_factory.build_s3_client(conn, provider_id)
    lc = _read(client, "get_bucket_lifecycle_configuration", Bucket=bucket)
    ver = _read(client, "get_bucket_versioning", Bucket=bucket)
    tagging = _read(client, "get_bucket_tagging", Bucket=bucket)

    facts = _lifecycle_facts(lc)
    versioning_on = _versioning_enabled(ver)
    has_tags = tagging["status"] == AVAILABLE and bool(tagging["data"].get("TagSet"))
    findings: list[dict[str, str]] = []

    if lc["status"] == NOT_CONFIGURED:
        findings.append(_finding(OPPORTUNITY, "No lifecycle for cost control",
                                 "Add transition/expiration rules to reduce storage cost."))
    elif lc["status"] == AVAILABLE:
        if not facts["has_transition"] and not facts["has_expiration"]:
            findings.append(_finding(OPPORTUNITY, "No transition or expiration rules",
                                     "Lifecycle has no cost-reducing transitions or expirations."))
        if not facts["has_abort_mpu"]:
            findings.append(_finding(WARNING, "No incomplete-multipart cleanup",
                                     "Incomplete multipart uploads accrue cost; add an abort rule."))
    if versioning_on and not facts["has_noncurrent_expiration"]:
        findings.append(_finding(WARNING, "Noncurrent versions never expire",
                                 "Versioning is enabled without noncurrent version cleanup."))
    if not has_tags:
        findings.append(_finding(OPPORTUNITY, "No tags for cost attribution",
                                 "Add tags to attribute storage cost."))
    findings += _unsupported_findings(lc["status"], "lifecycle")

    # Phase 06 does not require Phase 05 results; suggest deeper analysis instead.
    findings.append(_finding(OPPORTUNITY, "Deeper cost analysis available",
                             "Run inventory_analysis on an inventory file to assess small-object ratio and cold data."))

    return {
        "success": True,
        "facts": {"lifecycle_status": lc["status"], "versioning_enabled": versioning_on,
                  "has_tags": has_tags, **facts},
        "findings": findings,
    }


# --- 6. review_bucket_performance_profile -----------------------------------


def review_bucket_performance_profile(
    conn: sqlite3.Connection, provider_id: str, bucket: str, prefix: str | None = None
) -> dict[str, Any]:
    client = client_factory.build_s3_client(conn, provider_id)
    findings: list[dict[str, str]] = []

    sample = _read(client, "list_objects_v2", Bucket=bucket, Prefix=prefix or "",
                   MaxKeys=PERF_MAX_KEYS, Delimiter="/")
    if sample["status"] == ACCESS_DENIED:
        findings.append(_finding(WARNING, "Cannot list objects (access denied)",
                                 "Performance profiling is inconclusive without list permission."))
        return {"success": True, "facts": {"list_status": ACCESS_DENIED, "inconclusive": True}, "findings": findings}
    if sample["status"] != AVAILABLE:
        findings += _unsupported_findings(sample["status"], "list_objects_v2") or [
            _finding(NOT_APPLICABLE, "Object listing unavailable", "Could not sample objects for profiling.")]
        return {"success": True, "facts": {"list_status": sample["status"], "inconclusive": True}, "findings": findings}

    data = sample["data"]
    contents = data.get("Contents", []) or []
    common_prefixes = [p.get("Prefix") for p in data.get("CommonPrefixes", []) or []][:SAMPLE_LIMIT]
    sizes = [c.get("Size", 0) for c in contents]
    sample_keys = [c.get("Key") for c in contents[:SAMPLE_LIMIT]]
    small = sum(1 for s in sizes if s is not None and s < SMALL_OBJECT_BYTES)
    small_ratio = round(small / len(sizes), 4) if sizes else 0.0

    if sizes and small_ratio > 0.5:
        findings.append(_finding(OPPORTUNITY, "Small-object tendency in sample",
                                 f"{small_ratio:.0%} of the {len(sizes)}-object sample is under 1 MiB; "
                                 "consider packing or analyzing inventory."))
    findings.append(_finding(NOT_APPLICABLE, "Bounded sample only",
                             f"Profiled a bounded sample (max_keys={PERF_MAX_KEYS}); "
                             "run inventory_analysis for accurate, full numbers."))

    return {
        "success": True,
        "facts": {
            "list_status": AVAILABLE,
            "sampled_objects": len(sizes),
            "is_truncated": bool(data.get("IsTruncated", False)),
            "common_prefixes": common_prefixes,
            "sample_keys": sample_keys,
            "small_object_ratio_sample": small_ratio,
            "max_keys": PERF_MAX_KEYS,
        },
        "findings": findings,
    }
