"""Whitelisted READ-ONLY S3-compatible tools.

Every function here is non-destructive. Errors are sanitized before being
returned so that Authorization headers, signatures, credentials, and tokens
never leak. No object bodies are persisted; range reads are bounded.
"""

from __future__ import annotations

import socket
import sqlite3
import ssl
import time
from typing import Any
from urllib.parse import urlparse

from botocore.exceptions import ClientError

from ..security.redaction import redact, redact_text
from . import client_factory

# --- Limits -----------------------------------------------------------------

MAX_LIST_KEYS = 1000          # backend hard cap for list_objects_v2 MaxKeys
SAMPLE_KEYS_LIMIT = 20        # max object keys echoed back
MAX_RANGE_BYTES = 4 * 1024 * 1024   # hard cap on a single range read (4 MiB)
TLS_TIMEOUT = 5

_AUTH_FAIL_CODES = {
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
    "TokenRefreshRequired",
    "ExpiredToken",
    "ExpiredTokenException",
    "InvalidToken",
    "UnrecognizedClientException",
}
_UNSUPPORTED_CODES = {"NotImplemented", "MethodNotAllowed"}
_DENIED_CODES = {"AccessDenied", "Forbidden", "AllAccessDisabled", "UnauthorizedAccess"}

# Read status vocabulary shared with config_tools (Phase 14 account discovery).
AVAILABLE = "available"
PROVIDER_UNSUPPORTED = "provider_unsupported"
ACCESS_DENIED = "access_denied"
ERROR = "error"


# --- Error helpers ----------------------------------------------------------


def _client_error_fields(exc: ClientError) -> dict[str, Any]:
    resp = exc.response or {}
    err = resp.get("Error", {})
    meta = resp.get("ResponseMetadata", {})
    return {
        "error_code": err.get("Code"),
        "error_message_sanitized": redact_text(str(err.get("Message") or "")),
        "status_code": meta.get("HTTPStatusCode"),
    }


def _generic_error_fields(exc: Exception) -> dict[str, Any]:
    # Never include the raw exception text without redaction — it may carry a
    # presigned URL or header value.
    return {
        "error_code": type(exc).__name__,
        "error_message_sanitized": redact_text(str(exc)),
    }


def _sanitized_headers(meta: dict[str, Any]) -> dict[str, Any]:
    return redact(meta.get("HTTPHeaders", {}))


# --- 1. test_credentials ----------------------------------------------------


def test_credentials(conn: sqlite3.Connection, provider_id: str) -> dict[str, Any]:
    cfg = client_factory.load_provider(conn, provider_id)
    base = {
        "success": False,
        "provider_type": cfg.provider_type,
        "endpoint_url": cfg.endpoint_url,
        "region": cfg.region,
        "identity_hint": None,
        "error_code": None,
        "error_message_sanitized": None,
    }
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        resp = client.list_buckets()
        owner = resp.get("Owner", {}) or {}
        hint = (
            owner.get("DisplayName")
            or owner.get("ID")
            or f"{len(resp.get('Buckets', []))} bucket(s) visible"
        )
        return {**base, "success": True, "identity_hint": hint}
    except ClientError as exc:
        fields = _client_error_fields(exc)
        code = fields["error_code"]
        if code in _UNSUPPORTED_CODES:
            # Capability gap, not an auth failure.
            return {**base, "success": True, "identity_hint": "Provider unsupported"}
        if code == "AccessDenied":
            # Credentials are valid; the account just cannot ListBuckets.
            return {**base, "success": True, "identity_hint": "authenticated (ListBuckets denied)"}
        if code in _AUTH_FAIL_CODES:
            return {**base, **fields, "success": False}
        return {**base, **fields, "success": False}
    except Exception as exc:  # noqa: BLE001 - sanitized below
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 1b. list_buckets (account-level, read-only) ----------------------------


def list_buckets(conn: sqlite3.Connection, provider_id: str) -> dict[str, Any]:
    """Enumerate the buckets visible to the credentials (read-only ListBuckets).

    This is the ONLY listing performed — it never calls ListObjectsV2 and never
    touches object bodies. Bucket names pass through redaction defensively
    (normal names are unchanged). Capability/permission gaps are surfaced as
    ``provider_unsupported`` / ``access_denied`` rather than crashing the run.
    """
    base = {
        "success": False,
        "status": ERROR,
        "provider_id": provider_id,
        "bucket_count": 0,
        "buckets": [],
        "warnings": [],
        "provider_capabilities": {},
        "error_code": None,
        "error_message_sanitized": None,
    }
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        resp = client.list_buckets()
        buckets = []
        for b in resp.get("Buckets", []) or []:
            cd = b.get("CreationDate")
            buckets.append({
                "name": redact_text(str(b.get("Name") or "")),
                "creation_date": cd.isoformat() if hasattr(cd, "isoformat") else cd,
                "status": "visible",
            })
        return {
            **base,
            "success": True,
            "status": AVAILABLE,
            "bucket_count": len(buckets),
            "buckets": buckets,
            "provider_capabilities": {"list_buckets": AVAILABLE},
        }
    except ClientError as exc:
        fields = _client_error_fields(exc)
        code = fields["error_code"]
        http = fields["status_code"]
        if code in _UNSUPPORTED_CODES or http == 501:
            status = PROVIDER_UNSUPPORTED
        elif code in _DENIED_CODES or http == 403:
            status = ACCESS_DENIED
        else:
            status = ERROR
        return {
            **base, **fields, "success": False, "status": status,
            "warnings": [f"ListBuckets {status}"],
            "provider_capabilities": {"list_buckets": status},
        }
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False, "status": ERROR,
                "warnings": ["ListBuckets error"]}


# --- 2. head_bucket ---------------------------------------------------------


def head_bucket(conn: sqlite3.Connection, provider_id: str, bucket: str) -> dict[str, Any]:
    base = {
        "success": False,
        "status_code": None,
        "headers_sanitized": {},
        "error_code": None,
        "error_message_sanitized": None,
    }
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        resp = client.head_bucket(Bucket=bucket)
        meta = resp.get("ResponseMetadata", {})
        return {
            **base,
            "success": True,
            # A successful HeadBucket is a 200; default if the metadata omits it.
            "status_code": meta.get("HTTPStatusCode") or 200,
            "headers_sanitized": _sanitized_headers(meta),
        }
    except ClientError as exc:
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 3. list_objects_v2 -----------------------------------------------------


def list_objects_v2(
    conn: sqlite3.Connection,
    provider_id: str,
    bucket: str,
    max_keys: int,
    prefix: str | None = None,
    continuation_token: str | None = None,
    delimiter: str | None = "/",
) -> dict[str, Any]:
    """Bounded ListObjectsV2. One page only (no auto-scan); the caller pages by
    re-calling with ``next_token`` until it is null. ``delimiter`` defaults to
    ``/`` (directory-style); pass ``""``/``None`` to list keys recursively.
    """
    base = {
        "success": False,
        "key_count": 0,
        "common_prefixes": [],
        "sample_keys": [],
        "keys": [],
        "is_truncated": False,
        "next_token": None,
        "error_code": None,
        "error_message_sanitized": None,
    }
    # Per-call hard cap; pagination is explicit (next_token), never automatic.
    clamped = max(1, min(int(max_keys), MAX_LIST_KEYS))
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        kw: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix or "", "MaxKeys": clamped}
        if delimiter:
            kw["Delimiter"] = delimiter
        if continuation_token:
            kw["ContinuationToken"] = continuation_token
        resp = client.list_objects_v2(**kw)
        contents = resp.get("Contents", []) or []
        common = [p.get("Prefix") for p in resp.get("CommonPrefixes", []) or []]
        all_keys = [c.get("Key") for c in contents]
        return {
            **base,
            "success": True,
            "key_count": resp.get("KeyCount", len(contents)),
            "common_prefixes": common,
            # sample_keys: small preview (back-compat); keys: the full page so the
            # agent can enumerate by paging.
            "sample_keys": all_keys[:SAMPLE_KEYS_LIMIT],
            "keys": all_keys[:clamped],
            "is_truncated": bool(resp.get("IsTruncated", False)),
            "next_token": resp.get("NextContinuationToken"),
        }
    except ClientError as exc:
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 4. head_object ---------------------------------------------------------


def head_object(
    conn: sqlite3.Connection, provider_id: str, bucket: str, key: str
) -> dict[str, Any]:
    base = {
        "success": False,
        "size": None,
        "etag": None,
        "last_modified": None,
        "storage_class": None,
        "metadata_sanitized": {},
        "error_code": None,
        "error_message_sanitized": None,
    }
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        resp = client.head_object(Bucket=bucket, Key=key)
        lm = resp.get("LastModified")
        return {
            **base,
            "success": True,
            "size": resp.get("ContentLength"),
            "etag": resp.get("ETag"),
            "last_modified": lm.isoformat() if hasattr(lm, "isoformat") else lm,
            "storage_class": resp.get("StorageClass"),
            "metadata_sanitized": redact(resp.get("Metadata", {}) or {}),
        }
    except ClientError as exc:
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 5. test_range_get ------------------------------------------------------


def _parse_range_length(range_header: str) -> int | None:
    """Return the number of bytes a Range header requests, or None if unbounded."""
    if not range_header or not range_header.strip().lower().startswith("bytes="):
        return None
    spec = range_header.split("=", 1)[1].strip()
    if "," in spec:  # multi-range not allowed
        return None
    start_s, sep, end_s = spec.partition("-")
    if not sep:
        return None
    if start_s == "":  # suffix form: bytes=-N
        return int(end_s) if end_s.isdigit() else None
    if end_s == "":  # open-ended: bytes=start-  → unbounded (could be full object)
        return None
    if start_s.isdigit() and end_s.isdigit():
        return int(end_s) - int(start_s) + 1
    return None


def test_range_get(
    conn: sqlite3.Connection,
    provider_id: str,
    bucket: str,
    key: str,
    range_header: str,
) -> dict[str, Any]:
    base = {
        "success": False,
        "status_code": None,
        "content_range": None,
        "bytes_returned": 0,
        "latency_ms": None,
        "error_code": None,
        "error_message_sanitized": None,
    }
    length = _parse_range_length(range_header or "")
    if length is None:
        return {
            **base,
            "error_code": "RangeRequired",
            "error_message_sanitized": (
                "A bounded Range header is required (e.g. 'bytes=0-1048575'); "
                "open-ended or missing ranges are rejected to prevent full downloads."
            ),
        }
    if length > MAX_RANGE_BYTES:
        return {
            **base,
            "error_code": "RangeTooLarge",
            "error_message_sanitized": (
                f"Requested range of {length} bytes exceeds the {MAX_RANGE_BYTES}-byte cap."
            ),
        }

    try:
        client = client_factory.build_s3_client(conn, provider_id)
        started = time.monotonic()
        resp = client.get_object(Bucket=bucket, Key=key, Range=range_header)
        body = resp.get("Body")
        # Read at most the hard cap, then discard — content is never stored.
        data = body.read(MAX_RANGE_BYTES) if body is not None else b""
        bytes_returned = len(data)
        del data
        if body is not None and hasattr(body, "close"):
            body.close()
        latency_ms = int((time.monotonic() - started) * 1000)
        meta = resp.get("ResponseMetadata", {})
        return {
            **base,
            "success": True,
            "status_code": meta.get("HTTPStatusCode"),
            "content_range": resp.get("ContentRange"),
            "bytes_returned": bytes_returned,
            "latency_ms": latency_ms,
        }
    except ClientError as exc:
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 6. test_path_style_vs_virtual_host -------------------------------------


def _probe_style(conn: sqlite3.Connection, provider_id: str, bucket: str, style: str) -> dict[str, Any]:
    try:
        client = client_factory.build_s3_client(
            conn, provider_id, addressing_style_override=style
        )
        client.head_bucket(Bucket=bucket)
        return {"success": True, "error_code": None, "error_message_sanitized": None}
    except ClientError as exc:
        f = _client_error_fields(exc)
        return {"success": False, "error_code": f["error_code"], "error_message_sanitized": f["error_message_sanitized"]}
    except Exception as exc:  # noqa: BLE001
        f = _generic_error_fields(exc)
        return {"success": False, "error_code": f["error_code"], "error_message_sanitized": f["error_message_sanitized"]}


def test_path_style_vs_virtual_host(
    conn: sqlite3.Connection, provider_id: str, bucket: str
) -> dict[str, Any]:
    virtual = _probe_style(conn, provider_id, bucket, "virtual")
    path = _probe_style(conn, provider_id, bucket, "path")

    v_ok, p_ok = virtual["success"], path["success"]
    if v_ok and p_ok:
        recommendation = "both_work"
    elif v_ok:
        recommendation = "virtual"
    elif p_ok:
        recommendation = "path"
    elif virtual["error_code"] and path["error_code"]:
        # Both got definite HTTP responses → genuinely both fail.
        recommendation = "both_fail"
    else:
        # At least one failed without a clear HTTP response (e.g. connection error).
        recommendation = "inconclusive"

    return {
        "virtual_hosted_result": virtual,
        "path_style_result": path,
        "recommendation": recommendation,
    }


# --- 7. inspect_tls ---------------------------------------------------------


def _format_name(name_tuples: Any) -> str | None:
    if not name_tuples:
        return None
    parts: list[str] = []
    for rdn in name_tuples:
        for key, value in rdn:
            parts.append(f"{key}={value}")
    return ", ".join(parts) if parts else None


def inspect_tls(endpoint_url: str) -> dict[str, Any]:
    base = {
        "tls_version": None,
        "certificate_subject": None,
        "certificate_issuer": None,
        "not_after": None,
        "sni_used": None,
        "error_message_sanitized": None,
    }
    # Strip the query string before doing anything — never log sensitive params.
    parsed = urlparse(endpoint_url if "://" in endpoint_url else f"https://{endpoint_url}")
    host = parsed.hostname
    port = parsed.port or 443
    if not host:
        return {**base, "error_message_sanitized": "Could not parse host from endpoint_url."}

    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=TLS_TIMEOUT) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                cert = ssock.getpeercert() or {}
                version = ssock.version()
        return {
            **base,
            "tls_version": version,
            "certificate_subject": _format_name(cert.get("subject")),
            "certificate_issuer": _format_name(cert.get("issuer")),
            "not_after": cert.get("notAfter"),
            "sni_used": host,
        }
    except Exception as exc:  # noqa: BLE001 - sanitized below
        return {
            **base,
            "sni_used": host,
            "error_message_sanitized": redact_text(str(exc)),
        }
