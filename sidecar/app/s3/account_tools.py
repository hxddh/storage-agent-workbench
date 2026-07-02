"""Account-level read-only discovery tools.

Builds on the Phase 06 read-only config readers (``config_tools._read``) to
produce, per bucket:

- a configuration snapshot with clear status enums
  (available / not_configured / provider_unsupported / access_denied / error);
- evidence-source discovery for inventory and server access logging — it only
  *discovers whether a source is configured*, it never pulls a full inventory
  report or access log, never scans objects, and never downloads object bodies.

Nothing here mutates anything (no put/delete/create/update), enables logging or
inventory, or auto-remediates. Outputs carry only structured facts — no raw
policy text, no account IDs, no credentials, no ARNs beyond a destination bucket
name, no presigned URLs.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from ..security.redaction import redact_text
from . import client_factory
from . import config_tools as ct

SAMPLE_LIMIT = 20

# Evidence source types.
INVENTORY = "inventory"
SERVER_ACCESS_LOGGING = "server_access_logging"
# Reserved, not implemented yet — surfaced honestly, never faked as supported.
_PLACEHOLDER_SOURCES = ("cloudtrail", "storage_lens", "provider_access_log")


def _dim_status(read: dict[str, Any], configured: bool) -> str:
    """Map a read result + 'is it actually configured' to a status enum."""
    if read["status"] == ct.AVAILABLE:
        return ct.AVAILABLE if configured else ct.NOT_CONFIGURED
    return read["status"]


def _bucket_arn_to_name(value: Any) -> str | None:
    """Reduce an inventory destination ARN to just the bucket name (no account id)."""
    if not value:
        return None
    s = str(value)
    if s.startswith("arn:") and ":::" in s:
        s = s.split(":::", 1)[1]
    # Defensive redaction (normal names are unchanged).
    return redact_text(s)


# --- bucket config snapshot -------------------------------------------------


def get_bucket_config_snapshot(
    conn: sqlite3.Connection, provider_id: str, bucket: str
) -> dict[str, Any]:
    """Collect a read-only configuration snapshot for one bucket."""
    cfg = client_factory.load_provider(conn, provider_id)
    client = client_factory.build_s3_client(conn, provider_id)

    # head_bucket: existence/reachability (not a get_* config read).
    head_status = ct.AVAILABLE
    try:
        client.head_bucket(Bucket=bucket)
    except Exception as exc:  # noqa: BLE001 - mapped, never raised
        head_status = ct.ERROR
        # `response` may exist but be None (some botocore/urllib exceptions), so
        # `getattr(..., {})` alone isn't enough — coerce with `or {}` before .get.
        resp = (getattr(exc, "response", {}) or {})
        code = resp.get("Error", {}).get("Code")
        http = resp.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in ct._DENIED_CODES or http == 403:
            head_status = ct.ACCESS_DENIED
        elif code in ct._UNSUPPORTED_CODES or http == 501:
            head_status = ct.PROVIDER_UNSUPPORTED

    location = ct._read(client, "get_bucket_location", Bucket=bucket)
    versioning = ct._read(client, "get_bucket_versioning", Bucket=bucket)
    encryption = ct._read(client, "get_bucket_encryption", Bucket=bucket)
    lifecycle = ct._read(client, "get_bucket_lifecycle_configuration", Bucket=bucket)
    logging_r = ct._read(client, "get_bucket_logging", Bucket=bucket)
    replication = ct._read(client, "get_bucket_replication", Bucket=bucket)
    policy = ct._read(client, "get_bucket_policy", Bucket=bucket)
    pab = ct._read(client, "get_public_access_block", Bucket=bucket)
    tagging = ct._read(client, "get_bucket_tagging", Bucket=bucket)
    inventory = ct._read(client, "list_bucket_inventory_configurations", Bucket=bucket)

    # region: prefer the bucket location; fall back to the provider's region.
    region = cfg.region
    if location["status"] == ct.AVAILABLE:
        loc = location["data"].get("LocationConstraint")
        region = loc or cfg.region or "us-east-1"

    versioning_enabled = (
        versioning["status"] == ct.AVAILABLE
        and versioning["data"].get("Status") == "Enabled"
    )
    enc_configured = (
        encryption["status"] == ct.AVAILABLE
        and bool(encryption["data"].get("ServerSideEncryptionConfiguration", {}).get("Rules"))
    )
    lc_configured = lifecycle["status"] == ct.AVAILABLE and bool(lifecycle["data"].get("Rules"))
    logging_enabled = logging_r["status"] == ct.AVAILABLE and bool(logging_r["data"].get("LoggingEnabled"))
    repl_configured = replication["status"] == ct.AVAILABLE and bool(
        replication["data"].get("ReplicationConfiguration", {}).get("Rules")
    )
    policy_configured = policy["status"] == ct.AVAILABLE
    pab_configured = pab["status"] == ct.AVAILABLE
    tagging_configured = tagging["status"] == ct.AVAILABLE and bool(tagging["data"].get("TagSet"))
    inv_configured = inventory["status"] == ct.AVAILABLE and bool(
        inventory["data"].get("InventoryConfigurationList")
    )

    snapshot = {
        "success": True,
        "bucket": bucket,
        "region": region,
        "head_bucket_status": head_status,
        "versioning_status": _dim_status(versioning, versioning_enabled),
        "versioning_enabled": versioning_enabled,
        "encryption_status": _dim_status(encryption, enc_configured),
        "lifecycle_status": _dim_status(lifecycle, lc_configured),
        "logging_status": _dim_status(logging_r, logging_enabled),
        "logging_enabled": logging_enabled,
        "replication_status": _dim_status(replication, repl_configured),
        "policy_status": _dim_status(policy, policy_configured),
        "public_access_block_status": _dim_status(pab, pab_configured),
        "tagging_status": _dim_status(tagging, tagging_configured),
        "inventory_status": _dim_status(inventory, inv_configured),
    }

    # Aggregate provider-unsupported / access-denied / error items by dimension.
    dim_reads = {
        "location": location, "versioning": versioning, "encryption": encryption,
        "lifecycle": lifecycle, "logging": logging_r, "replication": replication,
        "policy": policy, "public_access_block": pab, "tagging": tagging,
        "inventory": inventory,
    }
    snapshot["provider_unsupported_items"] = [
        n for n, r in dim_reads.items() if r["status"] == ct.PROVIDER_UNSUPPORTED
    ]
    snapshot["access_denied_items"] = [
        n for n, r in dim_reads.items() if r["status"] == ct.ACCESS_DENIED
    ]
    snapshot["errors"] = [n for n, r in dim_reads.items() if r["status"] == ct.ERROR]
    if head_status == ct.ACCESS_DENIED:
        snapshot["access_denied_items"].append("head_bucket")
    elif head_status == ct.ERROR:
        snapshot["errors"].append("head_bucket")
    return snapshot


# --- evidence source discovery ----------------------------------------------


def _discover_inventory(client, bucket: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "source_type": INVENTORY,
        "configured": False,
        "status": ct.NOT_CONFIGURED,
        "configurations": [],
    }
    r = ct._read(client, "list_bucket_inventory_configurations", Bucket=bucket)
    if r["status"] != ct.AVAILABLE:
        out["status"] = r["status"]
        return out
    cfgs = r["data"].get("InventoryConfigurationList") or []
    if not cfgs:
        out["status"] = ct.NOT_CONFIGURED
        return out
    out["configured"] = True
    out["status"] = ct.AVAILABLE
    for c in cfgs[:SAMPLE_LIMIT]:
        dest = (c.get("Destination") or {}).get("S3BucketDestination") or {}
        out["configurations"].append({
            "inventory_id": redact_text(str(c.get("Id") or "")),
            "destination_bucket": _bucket_arn_to_name(dest.get("Bucket")),
            "destination_prefix": redact_text(str(dest.get("Prefix") or "")) or None,
            "format": dest.get("Format"),
            "frequency": (c.get("Schedule") or {}).get("Frequency"),
            "included_object_versions": c.get("IncludedObjectVersions"),
            "is_enabled": c.get("IsEnabled"),
            "optional_fields": (c.get("OptionalFields") or [])[:SAMPLE_LIMIT],
        })
    return out


def _discover_logging(client, bucket: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "source_type": SERVER_ACCESS_LOGGING,
        "configured": False,
        "status": ct.NOT_CONFIGURED,
        "target_bucket": None,
        "target_prefix": None,
    }
    r = ct._read(client, "get_bucket_logging", Bucket=bucket)
    if r["status"] != ct.AVAILABLE:
        out["status"] = r["status"]
        return out
    le = r["data"].get("LoggingEnabled")
    if not le:
        out["status"] = ct.NOT_CONFIGURED
        return out
    out["configured"] = True
    out["status"] = ct.AVAILABLE
    out["target_bucket"] = redact_text(str(le.get("TargetBucket") or "")) or None
    out["target_prefix"] = redact_text(str(le.get("TargetPrefix") or "")) or None
    return out


def discover_evidence_sources(
    conn: sqlite3.Connection, provider_id: str, bucket: str
) -> dict[str, Any]:
    """Discover (not fetch) inventory / access-logging evidence for one bucket."""
    client = client_factory.build_s3_client(conn, provider_id)
    sources = [
        _discover_inventory(client, bucket),
        _discover_logging(client, bucket),
    ]
    # Future evidence types are reserved but explicitly not implemented.
    for name in _PLACEHOLDER_SOURCES:
        sources.append({"source_type": name, "configured": None, "status": "not_implemented"})
    return {"success": True, "bucket": bucket, "sources": sources}
