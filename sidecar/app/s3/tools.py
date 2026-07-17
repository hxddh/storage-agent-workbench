"""Whitelisted READ-ONLY S3-compatible tools.

Every function here is non-destructive. Errors are sanitized before being
returned so that Authorization headers, signatures, credentials, and tokens
never leak. No object bodies are persisted; range reads are bounded.
"""

from __future__ import annotations

import json
import socket
import sqlite3
import ssl
import time
import zlib
from typing import Any
from urllib.parse import urlparse

from botocore.exceptions import ClientError

from ..security.redaction import redact, redact_text
from . import client_factory

# --- Limits -----------------------------------------------------------------

MAX_LIST_KEYS = 1000          # backend hard cap for list_objects_v2 MaxKeys
SAMPLE_KEYS_LIMIT = 20        # max object keys echoed back
OBJECT_DETAIL_LIMIT = 100     # per-key {size,storage_class,last_modified} entries echoed
MAX_RANGE_BYTES = 4 * 1024 * 1024   # hard cap on a single range read (4 MiB)
TLS_TIMEOUT = 5
LATENCY_DEFAULT_SAMPLES = 5   # default round-trips for measure_request_latency
LATENCY_MAX_SAMPLES = 10      # hard cap on latency probe round-trips

_AUTH_FAIL_CODES = {
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
    "TokenRefreshRequired",
    "ExpiredToken",
    "ExpiredTokenException",
    "InvalidToken",
    "UnrecognizedClientException",
}
_UNSUPPORTED_CODES = {"NotImplemented", "MethodNotAllowed", "NotSupported", "Unsupported"}
_DENIED_CODES = {"AccessDenied", "Forbidden", "AllAccessDisabled", "UnauthorizedAccess"}

# Read status vocabulary shared with config_tools.
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


def _is_unsupported(exc: ClientError) -> bool:
    """A capability gap — the provider doesn't implement this API — by error code
    (NotImplemented/MethodNotAllowed/NotSupported/Unsupported) OR a bare HTTP
    501/405. A gateway that rejects an unimplemented operation with a code-less
    405 Method Not Allowed is the same gap as a coded MethodNotAllowed.
    Rule 18: such gaps are 'provider_unsupported', never a hard failure."""
    resp = exc.response or {}
    code = resp.get("Error", {}).get("Code")
    http = resp.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return code in _UNSUPPORTED_CODES or http in (501, 405)


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
        if code in _DENIED_CODES or (fields.get("status_code") == 403 and code
                                     and code not in _AUTH_FAIL_CODES):
            # Credentials are valid; the account just cannot ListBuckets. Mirror
            # list_buckets' full denied-code set (Forbidden/AllAccessDisabled/…),
            # plus a non-auth 403 so a provider using a non-standard permission
            # code isn't reported as broken credentials. A genuine auth-failure
            # code (InvalidAccessKeyId/SignatureDoesNotMatch/…) still falls
            # through to the failure path below even though it, too, is a 403 —
            # and so does a CODE-LESS 403 (we can't tell auth from permission
            # without a code, so don't claim the credentials are valid).
            return {**base, "success": True, "identity_hint": "authenticated (ListBuckets denied)"}
        # Everything else (auth failures included) is a genuine failure.
        return {**base, **fields, "success": False}
    except Exception as exc:  # noqa: BLE001 - sanitized below
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 1b. list_buckets (account-level, read-only) ----------------------------


def list_buckets(conn: sqlite3.Connection, provider_id: str) -> dict[str, Any]:
    """Enumerate the buckets visible to the credentials (read-only ListBuckets).

    This is the ONLY listing performed — it never calls ListObjectsV2 and never
    touches object bodies. Bucket names are returned verbatim (they are DNS-style
    identifiers reused as ``Bucket=`` arguments downstream, not secret material).
    Capability/permission gaps are surfaced as ``provider_unsupported`` /
    ``access_denied`` rather than crashing the run.
    """
    base = {
        "success": False,
        "status": ERROR,
        "provider_id": provider_id,
        "bucket_count": 0,
        "buckets": [],
        "list_truncated": False,
        "warnings": [],
        "provider_capabilities": {},
        "error_code": None,
        "error_message_sanitized": None,
    }
    # AWS ListBuckets now paginates (default 10k/page, quota up to 1M); a provider
    # that doesn't paginate simply returns no ContinuationToken and we stop after
    # one page. Bound the loop so a huge/quirky account can't spin, and surface
    # list_truncated so the count is never silently wrong.
    _MAX_BUCKET_PAGES = 50
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        buckets = []
        cont = None
        truncated = False
        for page in range(_MAX_BUCKET_PAGES):
            resp = client.list_buckets(**({"ContinuationToken": cont} if cont else {}))
            for b in resp.get("Buckets", []) or []:
                cd = b.get("CreationDate")
                # A bucket name is a DNS-style resource identifier, not secret
                # material — and account discovery reuses it verbatim as the
                # `Bucket=` argument for head_bucket / config snapshots. Running it
                # through redact_text can mangle a legitimately-named bucket (e.g.
                # one that trips a token-shaped pattern) into "***REDACTED***",
                # which then makes every per-bucket follow-up call fail. Keep the
                # raw name; secrets in error messages/headers are redacted
                # elsewhere.
                buckets.append({
                    "name": str(b.get("Name") or ""),
                    "creation_date": cd.isoformat() if hasattr(cd, "isoformat") else cd,
                    "status": "visible",
                })
            cont = resp.get("ContinuationToken")
            if not cont:
                break
            if page == _MAX_BUCKET_PAGES - 1:
                truncated = True
        return {
            **base,
            "success": True,
            "status": AVAILABLE,
            "bucket_count": len(buckets),
            "buckets": buckets,
            "list_truncated": truncated,
            "warnings": (["ListBuckets result truncated at the page cap; the "
                          "bucket_count is a lower bound."] if truncated else []),
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
            # Per-key detail (size / storage class / mtime) for the first
            # OBJECT_DETAIL_LIMIT entries — the skills sample size distribution
            # and storage classes from listings, which bare keys couldn't answer
            # without N follow-up head_object calls. Bounded so a 1000-key page
            # doesn't quadruple the context echo.
            "objects": [
                {"key": c.get("Key"), "size": c.get("Size"),
                 "storage_class": c.get("StorageClass"),
                 "last_modified": c["LastModified"].isoformat()
                 if hasattr(c.get("LastModified"), "isoformat") else c.get("LastModified")}
                for c in contents[:OBJECT_DETAIL_LIMIT]
            ],
            "is_truncated": bool(resp.get("IsTruncated", False)),
            "next_token": resp.get("NextContinuationToken"),
            # Report the applied cap so the caller can tell a requested max_keys
            # was clamped (never a silent cap): requested vs the enforced value.
            "max_keys_requested": int(max_keys),
            "max_keys_applied": clamped,
        }
    except ClientError as exc:
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 3b. list_object_versions -----------------------------------------------


def list_object_versions(
    conn: sqlite3.Connection,
    provider_id: str,
    bucket: str,
    prefix: str | None = None,
    max_keys: int = MAX_LIST_KEYS,
    key_marker: str | None = None,
    version_id_marker: str | None = None,
) -> dict[str, Any]:
    """Bounded ListObjectVersions — surfaces the ACTUAL version/delete-marker
    pileup a versioned bucket carries (which config review can't see). One page;
    the caller pages via the returned markers. No object bodies.
    """
    base = {
        "success": False, "version_count": 0, "noncurrent_version_count": 0,
        "delete_marker_count": 0, "current_bytes": 0, "noncurrent_bytes": 0,
        "sample_keys": [], "is_truncated": False, "provider_unsupported": False,
        "next_key_marker": None, "next_version_id_marker": None,
        "error_code": None, "error_message_sanitized": None,
    }
    clamped = max(1, min(int(max_keys), MAX_LIST_KEYS))
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        kw: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix or "", "MaxKeys": clamped}
        if key_marker:
            kw["KeyMarker"] = key_marker
        if version_id_marker:
            kw["VersionIdMarker"] = version_id_marker
        resp = client.list_object_versions(**kw)
        versions = resp.get("Versions", []) or []
        markers = resp.get("DeleteMarkers", []) or []
        noncurrent = [v for v in versions if not v.get("IsLatest")]
        return {
            **base, "success": True,
            "version_count": len(versions),
            "noncurrent_version_count": len(noncurrent),
            "delete_marker_count": len(markers),
            "current_bytes": sum(int(v.get("Size") or 0) for v in versions if v.get("IsLatest")),
            "noncurrent_bytes": sum(int(v.get("Size") or 0) for v in noncurrent),
            "sample_keys": [v.get("Key") for v in versions[:SAMPLE_KEYS_LIMIT]],
            # Per-entry detail so the agent can point at WHICH version to inspect
            # (and hand its version_id to head_object/get_object_lock_status) —
            # bare keys couldn't answer "which one is the pileup?".
            "sample_versions": [
                {"key": v.get("Key"), "version_id": v.get("VersionId"),
                 "is_latest": bool(v.get("IsLatest")), "is_delete_marker": False,
                 "size": v.get("Size"), "storage_class": v.get("StorageClass"),
                 "last_modified": v["LastModified"].isoformat()
                 if hasattr(v.get("LastModified"), "isoformat") else v.get("LastModified")}
                for v in versions[:SAMPLE_KEYS_LIMIT]
            ] + [
                {"key": m.get("Key"), "version_id": m.get("VersionId"),
                 "is_latest": bool(m.get("IsLatest")), "is_delete_marker": True,
                 "size": None, "storage_class": None,
                 "last_modified": m["LastModified"].isoformat()
                 if hasattr(m.get("LastModified"), "isoformat") else m.get("LastModified")}
                for m in markers[:SAMPLE_KEYS_LIMIT]
            ],
            "is_truncated": bool(resp.get("IsTruncated", False)),
            "next_key_marker": resp.get("NextKeyMarker"),
            "next_version_id_marker": resp.get("NextVersionIdMarker"),
        }
    except ClientError as exc:
        # Rule 18: a provider that doesn't implement ListObjectVersions (501/
        # NotImplemented) is a capability gap, not a hard failure — and not "0
        # versions" (which would read as a clean bucket). Flag it so the agent
        # narrates "version listing unsupported here", like the sibling tools.
        if _is_unsupported(exc):
            return {**base, **_client_error_fields(exc), "success": True,
                    "provider_unsupported": True}
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 3c. list_multipart_uploads ---------------------------------------------


def list_multipart_uploads(
    conn: sqlite3.Connection,
    provider_id: str,
    bucket: str,
    max_uploads: int = MAX_LIST_KEYS,
    prefix: str | None = None,
    key_marker: str | None = None,
    upload_id_marker: str | None = None,
) -> dict[str, Any]:
    """Bounded ListMultipartUploads — surfaces incomplete/abandoned multipart
    uploads (a common silent cost leak: parts are billed but invisible in a normal
    object listing). Read-only; listing only — aborting is a mutation and is out.
    """
    base = {
        "success": False, "upload_count": 0, "oldest_initiated": None,
        "sample_keys": [], "is_truncated": False, "provider_unsupported": False,
        "next_key_marker": None, "next_upload_id_marker": None,
        "error_code": None, "error_message_sanitized": None,
    }
    clamped = max(1, min(int(max_uploads), MAX_LIST_KEYS))
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        kw: dict[str, Any] = {"Bucket": bucket, "MaxUploads": clamped}
        if prefix:
            kw["Prefix"] = prefix
        if key_marker:
            kw["KeyMarker"] = key_marker
        if upload_id_marker:
            kw["UploadIdMarker"] = upload_id_marker
        resp = client.list_multipart_uploads(**kw)
        uploads = resp.get("Uploads", []) or []
        initiated = [u.get("Initiated") for u in uploads if u.get("Initiated")]
        oldest = min(initiated) if initiated else None
        return {
            **base, "success": True,
            "upload_count": len(uploads),
            "oldest_initiated": oldest.isoformat() if hasattr(oldest, "isoformat") else (str(oldest) if oldest else None),
            "sample_keys": [u.get("Key") for u in uploads[:SAMPLE_KEYS_LIMIT]],
            "is_truncated": bool(resp.get("IsTruncated", False)),
            "next_key_marker": resp.get("NextKeyMarker"),
            "next_upload_id_marker": resp.get("NextUploadIdMarker"),
        }
    except ClientError as exc:
        # Rule 18: ListMultipartUploads unsupported (501/NotImplemented) is a
        # capability gap, not a hard failure or "0 uploads".
        if _is_unsupported(exc):
            return {**base, **_client_error_fields(exc), "success": True,
                    "provider_unsupported": True}
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 4. head_object ---------------------------------------------------------


def head_object(
    conn: sqlite3.Connection, provider_id: str, bucket: str, key: str,
    version_id: str | None = None,
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
        kw: dict[str, Any] = {"Bucket": bucket, "Key": key}
        if version_id:
            kw["VersionId"] = version_id
        resp = client.head_object(**kw)
        lm = resp.get("LastModified")
        # Server-side encryption state: the security skill needs this to reason
        # about "why can't I read this object" (KMS-encrypted objects require key
        # access). The KMS key id is reduced to its last segment (alias/key-id) so
        # no account id / full ARN leaks; the value is redacted defensively.
        sse = resp.get("ServerSideEncryption")
        kms_key = resp.get("SSEKMSKeyId")
        kms_key_ref = redact(str(kms_key).split("/")[-1].split(":")[-1]) if kms_key else None
        # The same HeadObject response carries a set of diagnostic fields that
        # were previously dropped — each answers a real question the skills
        # reference (replication state, GLACIER restore progress/expiry,
        # multipart part count, lifecycle expiry, cache/content headers).
        # Restore/Expiration are provider strings (dates + rule ids) — redacted.
        expiration = resp.get("Expiration")
        restore = resp.get("Restore")
        return {
            **base,
            "success": True,
            "size": resp.get("ContentLength"),
            "etag": resp.get("ETag"),
            "last_modified": lm.isoformat() if hasattr(lm, "isoformat") else lm,
            "storage_class": resp.get("StorageClass"),
            "server_side_encryption": sse,
            "sse_kms_key_ref": kms_key_ref,
            "metadata_sanitized": redact(resp.get("Metadata", {}) or {}),
            "version_id": resp.get("VersionId"),
            "replication_status": resp.get("ReplicationStatus"),
            "restore": redact_text(str(restore)) if restore else None,
            "archive_status": resp.get("ArchiveStatus"),
            "parts_count": resp.get("PartsCount"),
            "lifecycle_expiration": redact_text(str(expiration)) if expiration else None,
            "content_type": resp.get("ContentType"),
            "content_encoding": resp.get("ContentEncoding"),
            "cache_control": resp.get("CacheControl"),
            "website_redirect_location": redact_text(str(resp.get("WebsiteRedirectLocation")))
            if resp.get("WebsiteRedirectLocation") else None,
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


# --- 5b. preview_object -----------------------------------------------------

PREVIEW_MAX_BYTES = 1 * 1024 * 1024  # hard cap on a single content preview (1 MiB)
# Content-type prefixes/markers we treat as binary and never decode as text.
_BINARY_CONTENT_MARKERS = (
    "image/", "video/", "audio/", "font/", "application/octet-stream",
    "application/zip", "application/gzip", "application/x-tar", "application/pdf",
    "application/x-parquet", "application/vnd.apache.parquet",
)


def _gunzip_bounded(data: bytes, cap: int) -> tuple[bytes | None, bool]:
    """Decompress a gzip prefix, emitting at most ``cap`` output bytes.

    Returns (output, complete). ``complete`` is True only when the whole gzip
    stream was consumed — a False means the preview is a prefix. None output
    means the bytes weren't actually a valid gzip stream.
    """
    try:
        d = zlib.decompressobj(wbits=31)  # gzip container
        out = d.decompress(data, cap)
        return out, bool(d.eof)
    except zlib.error:
        return None, False


class _TailFile:
    """Minimal seekable file-like over the LAST bytes of an object.

    Lets pyarrow parse a parquet FOOTER (schema/row counts) from one bounded
    suffix-range GET, without ever downloading the object body. Any access
    before the fetched tail raises — parsing then falls back to the plain
    "binary" report instead of fetching more.
    """

    closed = False
    mode = "rb"

    def __init__(self, data: bytes, total: int) -> None:
        self._data = data
        self._total = int(total)
        self._start = self._total - len(data)
        self._pos = 0

    def size(self) -> int:
        return self._total

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = 0) -> int:
        if whence == 0:
            pos = offset
        elif whence == 1:
            pos = self._pos + offset
        elif whence == 2:
            pos = self._total + offset
        else:  # pragma: no cover - defensive
            raise ValueError(f"bad whence {whence}")
        if pos < self._start:
            raise OSError("seek before the fetched tail (footer larger than preview cap)")
        self._pos = pos
        return pos

    def read(self, n: int = -1) -> bytes:
        i = self._pos - self._start
        if i < 0:
            raise OSError("read before the fetched tail")
        chunk = self._data[i:] if n is None or n < 0 else self._data[i:i + n]
        self._pos += len(chunk)
        return chunk

    def close(self) -> None:  # pragma: no cover - no-op
        pass

    def flush(self) -> None:  # pragma: no cover - no-op
        pass


def _preview_parquet(client, bucket: str, key: str, cap: int,
                     base: dict[str, Any]) -> dict[str, Any]:
    """Bounded parquet STRUCTURE preview: schema + row counts from the footer.

    One suffix-range GET (≤ cap bytes, the same preview budget) — never the
    object body. Falls back to the plain binary report if the footer can't be
    parsed within the cap.
    """
    binary_fallback = {
        **base, "success": True, "binary": True,
        "error_message_sanitized": (
            "Object looks binary; content not previewed (text only). "
            "(Parquet footer could not be parsed within the preview cap.)"
        ),
    }
    try:
        resp = client.get_object(Bucket=bucket, Key=key, Range=f"bytes=-{cap}")
    except ClientError as exc:
        fields = _client_error_fields(exc)
        if fields.get("error_code") in ("InvalidRange", "416") or fields.get("status_code") == 416:
            return {**base, "success": True, "content": "", "bytes_read": 0,
                    "object_size": 0, "truncated": False}
        return {**base, **fields, "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}

    try:
        body = resp.get("Body")
        data = body.read(cap) if body is not None else b""
        if body is not None and hasattr(body, "close"):
            body.close()
        cr = resp.get("ContentRange") or ""  # e.g. "bytes 900-999/1000"
        total = None
        if "/" in cr:
            tail = cr.rsplit("/", 1)[1]
            total = int(tail) if tail.isdigit() else None
        if total is None:
            if len(data) < cap:
                total = len(data)  # provider returned the whole (small) object
            else:
                return binary_fallback  # size unknown; can't trust tail math

        import pyarrow.parquet as pq  # bundled dependency (analysis engine)

        md = pq.read_metadata(_TailFile(data, total))
        schema = md.schema.to_arrow_schema()
        cols = [{"name": f.name, "type": str(f.type)} for f in schema][:100]
        return {
            **base, "success": True, "binary": True,
            "content_type": (resp.get("ContentType") or "").lower() or None,
            "object_size": total, "bytes_read": len(data), "truncated": False,
            "parquet": {
                "num_rows": int(md.num_rows),
                "num_row_groups": int(md.num_row_groups),
                "columns": cols,
            },
            "error_message_sanitized": (
                "Parquet structure preview (footer/schema only; object bodies "
                "are never downloaded)."
            ),
        }
    except Exception:  # noqa: BLE001 — any parse issue → honest binary report
        return binary_fallback


def _structure_hint(key: str, ctype: str, text: str) -> dict[str, Any] | None:
    """Best-effort STRUCTURE summary (columns / keys) for a text preview, so the
    agent gets a clean schema instead of re-parsing the raw head itself. Bounded,
    never raises, and NEVER fetches more bytes — it reads only the already-fetched
    preview text. Returns None when nothing structured is recognized (the raw text
    preview is unchanged in that case)."""
    name = (key or "").lower()
    try:
        if name.endswith((".json", ".geojson")) or "json" in ctype:
            s = text.lstrip()
            head = s[:1]
            if head == "{":
                obj = json.loads(s)  # fails on a truncated head → falls through
                if isinstance(obj, dict):
                    return {"format": "json", "root": "object", "keys": list(obj.keys())[:50]}
            elif head == "[":
                arr = json.loads(s)
                if isinstance(arr, list):
                    item_keys = list(arr[0].keys())[:50] if arr and isinstance(arr[0], dict) else None
                    return {"format": "json", "root": "array", "length": len(arr), "item_keys": item_keys}
        if name.endswith((".jsonl", ".ndjson")):
            first = text.lstrip().split("\n", 1)[0].strip()
            if first:
                obj = json.loads(first)
                if isinstance(obj, dict):
                    return {"format": "jsonl", "item_keys": list(obj.keys())[:50]}
        if name.endswith((".csv", ".tsv")) or "csv" in ctype or "tab-separated" in ctype:
            lines = [ln for ln in text.splitlines() if ln.strip()]
            if lines:
                delim = "\t" if (name.endswith(".tsv") or "\t" in lines[0]) else ","
                cols = [c.strip().strip('"') for c in lines[0].split(delim)]
                return {"format": "csv", "delimiter": "tab" if delim == "\t" else "comma",
                        "column_count": len(cols), "columns": cols[:100],
                        "sampled_rows": max(0, len(lines) - 1)}
    except Exception:  # noqa: BLE001 — structure is a bonus; never fail the preview
        return None
    return None


def preview_object(
    conn: sqlite3.Connection,
    provider_id: str,
    bucket: str,
    key: str,
    max_bytes: int | None = None,
) -> dict[str, Any]:
    """Read a BOUNDED, read-only, sanitized text preview of one object's head.

    A single bounded Range GET (≤ ``PREVIEW_MAX_BYTES``) of one named object. The
    body is never persisted; binary/oversized objects are reported, not decoded;
    the returned text is redaction-passed. This is the deliberate, bounded
    exception to "no object bodies" — the bounds ARE the safety.
    """
    cap = PREVIEW_MAX_BYTES if not max_bytes else max(1, min(int(max_bytes), PREVIEW_MAX_BYTES))
    base = {
        "success": False, "content": None, "bytes_read": 0, "object_size": None,
        "content_type": None, "truncated": False, "binary": False,
        "decompressed": False,
        "error_code": None, "error_message_sanitized": None,
    }
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        # Parquet: a bounded STRUCTURE preview (schema from the footer via one
        # suffix-range GET) instead of a flat "binary, not previewed" dead end.
        if key.lower().endswith((".parquet", ".pq")):
            return _preview_parquet(client, bucket, key, cap, base)
        resp = client.get_object(Bucket=bucket, Key=key, Range=f"bytes=0-{cap - 1}")
        ctype = (resp.get("ContentType") or "").lower()
        body = resp.get("Body")
        data = body.read(cap) if body is not None else b""
        if body is not None and hasattr(body, "close"):
            body.close()
        object_size = None
        cr = resp.get("ContentRange") or ""  # e.g. "bytes 0-1023/50000"
        if "/" in cr:
            tail = cr.rsplit("/", 1)[1]
            object_size = int(tail) if tail.isdigit() else None
        # Gzip (e.g. rotated .log.gz): decompress the fetched prefix, bounded to
        # the same cap on OUTPUT bytes — still no full-object read; the safety
        # bound is unchanged, only the dead end ("binary, not previewed") goes.
        if data[:2] == b"\x1f\x8b":
            out, complete = _gunzip_bounded(data, cap)
            if out is not None and b"\x00" not in out:
                text = redact_text(out.decode("utf-8", errors="replace"))
                more = (object_size is not None and object_size > len(data)) or not complete
                return {**base, "success": True, "content": text, "bytes_read": len(data),
                        "object_size": object_size, "content_type": ctype or None,
                        "truncated": more, "decompressed": True}
        is_binary = b"\x00" in data or any(m in ctype for m in _BINARY_CONTENT_MARKERS)
        if is_binary:
            return {**base, "success": True, "binary": True, "content_type": ctype or None,
                    "object_size": object_size, "bytes_read": len(data),
                    "error_message_sanitized": "Object looks binary; content not previewed (text only)."}
        text = redact_text(data.decode("utf-8", errors="replace"))
        # Known size and more remains → truncated. If the provider ignored the
        # Range header (200, no ContentRange) we can't know the true size, so
        # treat a full-cap read as possibly-truncated rather than reporting False.
        truncated = (
            (object_size is not None and object_size > len(data))
            or (object_size is None and len(data) >= cap)
        )
        out = {**base, "success": True, "content": text, "bytes_read": len(data),
               "object_size": object_size, "content_type": ctype or None, "truncated": truncated}
        # Bonus STRUCTURE summary for CSV/JSON (columns/keys) read from the SAME
        # preview bytes — no extra fetch, the raw text is still returned too.
        structure = _structure_hint(key, ctype, text)
        if structure is not None:
            out["structure"] = structure
        return out
    except ClientError as exc:
        fields = _client_error_fields(exc)
        # A Range GET on a zero-byte object returns 416 InvalidRange — that's an
        # empty object, not a failure. Report an empty, successful preview.
        if fields.get("error_code") in ("InvalidRange", "416") or fields.get("status_code") == 416:
            return {**base, "success": True, "content": "", "bytes_read": 0,
                    "object_size": 0, "truncated": False}
        return {**base, **fields, "success": False}
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


def _endpoint_is_ip(endpoint_url: str | None) -> bool:
    """True when the endpoint host is a bare IP (typical MinIO/Ceph: http://IP:9000)."""
    if not endpoint_url:
        return False
    from ipaddress import ip_address
    from urllib.parse import urlparse

    host = urlparse(endpoint_url).hostname or ""
    try:
        ip_address(host)
        return True
    except ValueError:
        return False


def test_path_style_vs_virtual_host(
    conn: sqlite3.Connection, provider_id: str, bucket: str
) -> dict[str, Any]:
    # botocore NEVER virtual-hosts against an IP endpoint — the "virtual" override
    # silently sends the identical path-style URL, so probing both would falsely
    # report `both_work` on the single most common S3-compatible setup (MinIO/Ceph
    # on an IP:port). Don't run a meaningless probe; report path and say why.
    cfg = client_factory.load_provider(conn, provider_id)
    if _endpoint_is_ip(cfg.endpoint_url):
        path = _probe_style(conn, provider_id, bucket, "path")
        return {
            "virtual_hosted_result": {
                "success": None, "not_testable": True,
                "error_code": None,
                "error_message_sanitized": "Endpoint is a bare IP address; "
                "virtual-hosted (bucket-in-hostname) addressing is impossible "
                "against an IP, so it cannot be tested — botocore uses path-style.",
            },
            "path_style_result": path,
            "recommendation": "path" if path["success"] else "inconclusive",
            "note": "IP endpoint: use path-style addressing (virtual-hosting is not possible).",
        }

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


# --- 8. measure_request_latency ---------------------------------------------


def _percentile(sorted_vals: list[float], pct: float) -> float | None:
    """Nearest-rank percentile over a small sorted sample."""
    if not sorted_vals:
        return None
    idx = int(round((pct / 100.0) * (len(sorted_vals) - 1)))
    idx = max(0, min(len(sorted_vals) - 1, idx))
    return sorted_vals[idx]


def measure_request_latency(
    conn: sqlite3.Connection,
    provider_id: str,
    bucket: str,
    key: str | None = None,
    samples: int = LATENCY_DEFAULT_SAMPLES,
) -> dict[str, Any]:
    """Measure live request latency to the endpoint with a BOUNDED number of
    lightweight round-trips. No object bodies are read: each probe is a HeadBucket
    (or HeadObject when ``key`` is given). The hard cap on ``samples`` makes this
    a diagnostic probe, not a load test — the bounds ARE the safety. This is the
    only tool that turns "it's slow" into measured min/p50/p95/max evidence.
    """
    n = max(1, min(int(samples), LATENCY_MAX_SAMPLES))
    op = "head_object" if key else "head_bucket"
    base = {
        # samples_requested is the caller's ACTUAL request; samples_applied is the
        # capped value actually run — so a request for 100 shows it was clamped to
        # 10, never a silent cap.
        "success": False, "operation": op,
        "samples_requested": int(samples), "samples_applied": n,
        "samples_ok": 0, "samples_failed": 0,
        "min_ms": None, "p50_ms": None, "p95_ms": None, "max_ms": None, "mean_ms": None,
        "error_code": None, "error_message_sanitized": None,
    }
    try:
        client = client_factory.build_s3_client(conn, provider_id)
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}

    def _one() -> None:
        if key:
            client.head_object(Bucket=bucket, Key=key)
        else:
            client.head_bucket(Bucket=bucket)

    latencies: list[float] = []
    failed = 0
    first_error: dict[str, Any] | None = None
    for _ in range(n):
        try:
            started = time.monotonic()
            _one()
            latencies.append((time.monotonic() - started) * 1000.0)
        except ClientError as exc:
            failed += 1
            if first_error is None:
                first_error = _client_error_fields(exc)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            if first_error is None:
                first_error = _generic_error_fields(exc)

    # No probe succeeded → surface the (sanitized) error rather than empty stats.
    if not latencies:
        return {**base, **(first_error or {}), "success": False, "samples_failed": failed}

    latencies.sort()
    result = {
        **base, "success": True,
        "samples_ok": len(latencies), "samples_failed": failed,
        "min_ms": round(latencies[0], 1),
        "p50_ms": round(_percentile(latencies, 50) or 0.0, 1),
        "p95_ms": round(_percentile(latencies, 95) or 0.0, 1),
        "max_ms": round(latencies[-1], 1),
        "mean_ms": round(sum(latencies) / len(latencies), 1),
    }
    # If some probes failed, keep the first sanitized error for context.
    if first_error:
        result["error_code"] = first_error.get("error_code")
        result["error_message_sanitized"] = first_error.get("error_message_sanitized")
    return result


# --- 9. get_object_lock_status ----------------------------------------------


def get_object_lock_status(
    conn: sqlite3.Connection,
    provider_id: str,
    bucket: str,
    key: str,
    version_id: str | None = None,
) -> dict[str, Any]:
    """Read one object's Object-Lock state: retention mode + retain-until date
    and legal-hold status. Answers "why can't I delete/overwrite this object?" at
    the OBJECT level, which bucket-level config review can't. Read-only; a missing
    retention/hold (or a provider that doesn't implement it) is reported as a
    normal state, not a hard failure.
    """
    base = {
        "success": False,
        "retention_mode": None, "retain_until_date": None, "retention_status": None,
        "legal_hold_status": None,
        "error_code": None, "error_message_sanitized": None,
    }
    # Codes meaning "no lock configured on this object", which is a valid answer.
    _NONE_CODES = {
        "NoSuchObjectLockConfiguration",
        "ObjectLockConfigurationNotFoundError",
    }

    def _is_no_lock(exc: ClientError) -> bool:
        err = (exc.response or {}).get("Error", {})
        if err.get("Code") in _NONE_CODES:
            return True
        # Real S3 returns the BROAD `InvalidRequest` ("Bucket is missing Object
        # Lock Configuration") on a bucket without Object Lock — the common case.
        # But InvalidRequest also covers genuinely malformed calls (e.g. a bad
        # version_id), so map it to "none" only in its object-lock flavor;
        # otherwise reporting "none" would read as "cleanly deletable" when the
        # truth is unknown.
        return (err.get("Code") == "InvalidRequest"
                and "object lock" in str(err.get("Message", "")).lower())
    try:
        client = client_factory.build_s3_client(conn, provider_id)
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}

    kw: dict[str, Any] = {"Bucket": bucket, "Key": key}
    if version_id:
        kw["VersionId"] = version_id

    result = {**base, "success": True, "retention_status": "none", "legal_hold_status": "none"}
    hard_error: dict[str, Any] | None = None

    # Retention (mode + retain-until).
    try:
        resp = client.get_object_retention(**kw)
        ret = resp.get("Retention") or {}
        mode = ret.get("Mode")
        until = ret.get("RetainUntilDate")
        if mode:
            result["retention_mode"] = mode
            result["retain_until_date"] = until.isoformat() if hasattr(until, "isoformat") else until
            result["retention_status"] = "active"
    except ClientError as exc:
        code = (exc.response or {}).get("Error", {}).get("Code")
        if _is_no_lock(exc):
            result["retention_status"] = "none"
        elif code in _UNSUPPORTED_CODES:
            result["retention_status"] = PROVIDER_UNSUPPORTED
        else:
            hard_error = _client_error_fields(exc)
    except Exception as exc:  # noqa: BLE001
        hard_error = _generic_error_fields(exc)

    # Legal hold (on/off).
    try:
        resp = client.get_object_legal_hold(**kw)
        status = (resp.get("LegalHold") or {}).get("Status")
        result["legal_hold_status"] = status.lower() if isinstance(status, str) else "none"
    except ClientError as exc:
        code = (exc.response or {}).get("Error", {}).get("Code")
        if _is_no_lock(exc):
            result["legal_hold_status"] = "none"
        elif code in _UNSUPPORTED_CODES:
            result["legal_hold_status"] = PROVIDER_UNSUPPORTED
        elif hard_error is None:
            hard_error = _client_error_fields(exc)
    except Exception as exc:  # noqa: BLE001
        if hard_error is None:
            hard_error = _generic_error_fields(exc)

    # A definite access/credential error (not a "no lock" answer) → report it.
    if hard_error and hard_error.get("error_code") in (_AUTH_FAIL_CODES | _DENIED_CODES):
        return {**base, **hard_error, "success": False}
    if hard_error:
        result["error_code"] = hard_error.get("error_code")
        result["error_message_sanitized"] = hard_error.get("error_message_sanitized")
    return result


# --- Object-level ACL / tagging / attributes (read-only) --------------------

# Predefined S3 group grantees. AllUsers = anonymous/public; AuthenticatedUsers
# = any AWS account (also effectively public). LogDelivery is the log-writer
# group. A grant to AllUsers/AuthenticatedUsers is the "this object is public"
# signal — we surface the group KIND, never a canonical user id / owner id / email.
_GRANT_ALL_USERS = "http://acs.amazonaws.com/groups/global/AllUsers"
_GRANT_AUTH_USERS = "http://acs.amazonaws.com/groups/global/AuthenticatedUsers"
_GRANT_LOG_DELIVERY = "http://acs.amazonaws.com/groups/s3/LogDelivery"


def _grantee_kind(grantee: dict[str, Any]) -> str:
    """Reduce a grantee to a KIND label — never its canonical id, email, or
    display name (all of which identify an account)."""
    uri = grantee.get("URI")
    if uri == _GRANT_ALL_USERS:
        return "public-all-users"
    if uri == _GRANT_AUTH_USERS:
        return "authenticated-users"
    if uri == _GRANT_LOG_DELIVERY:
        return "log-delivery"
    gtype = grantee.get("Type")
    if gtype == "CanonicalUser" or grantee.get("ID"):
        return "canonical-user"
    if gtype == "AmazonCustomerByEmail" or grantee.get("EmailAddress"):
        return "email-user"
    if gtype == "Group" or uri:
        return "group"
    return "unknown"


def get_object_acl(
    conn: sqlite3.Connection, provider_id: str, bucket: str, key: str,
    version_id: str | None = None,
) -> dict[str, Any]:
    """Read one object's ACL (read-only GetObjectAcl; no body). Answers "is this
    object public?" and "who was granted what?" at the OBJECT level, which
    bucket-level security review can't. Grantees are reduced to a KIND
    (public-all-users / authenticated-users / canonical-user / …) so no owner id,
    canonical id, or email leaks. A public grant (AllUsers / AuthenticatedUsers)
    is flagged explicitly. Provider without object-ACL support → provider_unsupported.
    """
    base = {
        "success": False, "grants": [], "is_public": False,
        "public_permissions": [], "owner_display": None,
        "error_code": None, "error_message_sanitized": None,
    }
    kw: dict[str, Any] = {"Bucket": bucket, "Key": key}
    if version_id:
        kw["VersionId"] = version_id
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        resp = client.get_object_acl(**kw)
    except ClientError as exc:
        if _is_unsupported(exc):
            return {**base, "success": True, "acl_status": PROVIDER_UNSUPPORTED}
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}

    all_grants = resp.get("Grants") or []
    # is_public is a SECURITY signal — compute it over EVERY grant, not just the
    # 20 echoed back; a public AllUsers/AuthenticatedUsers grant past position 20
    # must still flip is_public (S3 allows up to 100 grants per ACL).
    public_perms: list[str] = [
        g.get("Permission") for g in all_grants
        if _grantee_kind(g.get("Grantee") or {}) in ("public-all-users", "authenticated-users")
        and g.get("Permission")
    ]
    grants: list[dict[str, Any]] = [
        {"grantee_kind": _grantee_kind(g.get("Grantee") or {}), "permission": g.get("Permission")}
        for g in all_grants[:SAMPLE_KEYS_LIMIT]
    ]
    # Owner reduced to whether one exists — the DisplayName/ID identify an account.
    owner = resp.get("Owner") or {}
    return {
        **base,
        "success": True,
        "acl_status": AVAILABLE,
        "grants": grants,
        "grant_count": len(all_grants),
        "is_public": bool(public_perms),
        "public_permissions": sorted(set(public_perms)),
        "owner_display": "present" if (owner.get("ID") or owner.get("DisplayName")) else None,
    }


def get_object_tagging(
    conn: sqlite3.Connection, provider_id: str, bucket: str, key: str,
    version_id: str | None = None,
) -> dict[str, Any]:
    """Read one object's tag set (read-only GetObjectTagging; no body). Tags drive
    lifecycle/cost-attribution/access rules, so "what tags does this object carry?"
    is a real diagnostic. Both tag keys and values are redacted (they are
    user-controlled and may embed secrets). Bounded to 20 tags. An untagged object
    is a normal empty result; a provider without object tagging → provider_unsupported.
    """
    base = {
        "success": False, "tags": {}, "tag_count": 0,
        "error_code": None, "error_message_sanitized": None,
    }
    kw: dict[str, Any] = {"Bucket": bucket, "Key": key}
    if version_id:
        kw["VersionId"] = version_id
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        resp = client.get_object_tagging(**kw)
    except ClientError as exc:
        if _is_unsupported(exc):
            return {**base, "success": True, "tagging_status": PROVIDER_UNSUPPORTED}
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}

    tagset = resp.get("TagSet") or []
    tags: dict[str, str] = {}
    for t in tagset[:SAMPLE_KEYS_LIMIT]:
        k = redact_text(str(t.get("Key", "")))
        if k:
            tags[k] = redact_text(str(t.get("Value", "")))
    return {
        **base, "success": True, "tagging_status": AVAILABLE,
        "tags": tags, "tag_count": len(tagset),
    }


def get_object_attributes(
    conn: sqlite3.Connection, provider_id: str, bucket: str, key: str,
    version_id: str | None = None,
) -> dict[str, Any]:
    """Read one object's attributes — checksum, part count, storage class, size
    (read-only GetObjectAttributes; no body). Answers "how was this multipart
    object assembled?", "what checksum algorithm protects it?", "what storage
    class / size is it?" without a HEAD-then-GET dance. GetObjectAttributes is not
    universally implemented by S3-compatible providers → provider_unsupported on gap.
    """
    base = {
        "success": False, "storage_class": None, "size": None,
        "etag": None, "checksum_algorithm": None, "parts_count": None,
        "error_code": None, "error_message_sanitized": None,
    }
    kw: dict[str, Any] = {
        "Bucket": bucket, "Key": key,
        "ObjectAttributes": ["ETag", "Checksum", "ObjectParts", "StorageClass", "ObjectSize"],
    }
    if version_id:
        kw["VersionId"] = version_id
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        resp = client.get_object_attributes(**kw)
    except ClientError as exc:
        if _is_unsupported(exc):
            return {**base, "success": True, "attributes_status": PROVIDER_UNSUPPORTED}
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}

    checksum = resp.get("Checksum") or {}
    # Known algorithm keys only: the Checksum struct also carries ChecksumType
    # (COMPOSITE/FULL_OBJECT), which a prefix match would mis-extract as "Type".
    algo = next((a for a in ("CRC64NVME", "CRC32C", "CRC32", "SHA256", "SHA1")
                 if f"Checksum{a}" in checksum), None)
    parts = resp.get("ObjectParts") or {}
    return {
        **base, "success": True, "attributes_status": AVAILABLE,
        "storage_class": resp.get("StorageClass") or "STANDARD",
        "size": resp.get("ObjectSize"),
        "etag": resp.get("ETag"),
        "checksum_algorithm": algo,
        "parts_count": parts.get("TotalPartsCount"),
    }


# --- Presigned-URL diagnosis (pure parse — NO network, NO secrets echoed) ----


def diagnose_presigned_url(url: str) -> dict[str, Any]:
    """Parse a user-pasted presigned URL and explain why it might fail — WITHOUT
    making any request and WITHOUT echoing any credential material.

    Extracts: signature version (V2/V4), expiry (computed expired/valid from
    X-Amz-Date + X-Amz-Expires, or the V2 epoch Expires), the credential SCOPE
    (date/region/service — the access-key id itself is dropped), signed headers,
    and addressing style. The signature, key id, and security token never enter
    the result. Answers "my presigned URL 403s" (expired / wrong region scope /
    clock skew / wrong addressing) as a computation instead of an interview.
    """
    from datetime import datetime, timezone

    base: dict[str, Any] = {
        "success": False, "signature_version": None, "expired": None,
        "expires_at": None, "expires_in_seconds": None, "issued_at": None,
        "scope_date": None, "scope_region": None, "scope_service": None,
        "signed_headers": [], "addressing_style": None, "host": None,
        "key": None, "problems": [],
        "error_code": None, "error_message_sanitized": None,
    }
    try:
        parsed = urlparse(url.strip())
    except Exception:  # noqa: BLE001
        return {**base, "error_code": "InvalidUrl",
                "error_message_sanitized": "The value could not be parsed as a URL."}
    if not parsed.scheme or not parsed.netloc:
        return {**base, "error_code": "InvalidUrl",
                "error_message_sanitized": "The value could not be parsed as a URL."}
    from urllib.parse import parse_qs
    q = {k.lower(): v[0] for k, v in parse_qs(parsed.query, keep_blank_values=True).items()}
    problems: list[str] = []
    now = datetime.now(timezone.utc)

    out = {**base, "success": True, "host": redact_text(parsed.hostname or "")}
    # Addressing style: path-style URLs carry the bucket as the first path
    # segment; virtual-hosted URLs carry it in the host.
    path_parts = [p for p in (parsed.path or "").split("/") if p]
    if q.get("x-amz-algorithm") or q.get("x-amz-signature"):
        out["signature_version"] = "v4"
        cred = q.get("x-amz-credential", "")
        # Credential = <key-id>/<date>/<region>/<service>/aws4_request — keep the
        # SCOPE only; the key id (first segment) is dropped entirely.
        scope = cred.split("/")[1:] if "/" in cred else []
        if len(scope) >= 3:
            out["scope_date"], out["scope_region"], out["scope_service"] = scope[0], scope[1], scope[2]
        amz_date, expires_s = q.get("x-amz-date"), q.get("x-amz-expires")
        if amz_date:
            out["issued_at"] = amz_date
            try:
                issued = datetime.strptime(amz_date, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
                if issued > now:
                    problems.append("issued_in_future_check_clock_skew")
                if expires_s and expires_s.isdigit():
                    out["expires_in_seconds"] = int(expires_s)
                    exp = issued.timestamp() + int(expires_s)
                    out["expires_at"] = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat()
                    out["expired"] = exp < now.timestamp()
                    if out["expired"]:
                        problems.append("url_expired")
                    if int(expires_s) > 604800:
                        problems.append("expires_exceeds_v4_7day_max")
            except ValueError:
                problems.append("malformed_x_amz_date")
        out["signed_headers"] = [h for h in q.get("x-amz-signedheaders", "").split(";") if h]
        if not q.get("x-amz-signature"):
            problems.append("missing_signature_param")
    elif q.get("awsaccesskeyid") or (q.get("expires") and q.get("signature")):
        out["signature_version"] = "v2"
        exp_epoch = q.get("expires", "")
        if exp_epoch.isdigit():
            try:
                # V2 Expires is epoch SECONDS; a millisecond value (a common
                # mistake) overflows fromtimestamp — report it, don't crash.
                out["expires_at"] = datetime.fromtimestamp(int(exp_epoch), tz=timezone.utc).isoformat()
                out["expired"] = int(exp_epoch) < now.timestamp()
                if out["expired"]:
                    problems.append("url_expired")
            except (ValueError, OverflowError, OSError):
                problems.append("malformed_expires")
        problems.append("sigv2_legacy_many_providers_reject")
    else:
        out["signature_version"] = None
        problems.append("no_presign_parameters_found")

    # Addressing style + object key. Decide from the HOST, not the path length:
    # a virtual-hosted URL (bucket.s3.region.amazonaws.com/<key>) carries the
    # WHOLE path as the key, while a path-style URL (s3.region.amazonaws.com/
    # <bucket>/<key>) puts the bucket in the first path segment. The previous
    # path-length heuristic mislabelled the common virtual-hosted form AND
    # truncated its key by dropping the leading segment.
    host = (parsed.hostname or "").lower()
    labels = [x for x in host.split(".") if x]
    first = labels[0] if labels else ""
    is_aws = host.endswith("amazonaws.com")
    path_style = first == "s3" or first.startswith("s3-")
    virtual_hosted = (not path_style) and is_aws and len(labels) >= 3 and ".s3" in ("." + host)
    if virtual_hosted:
        out["addressing_style"] = "virtual"
        out["key"] = redact_text("/".join(path_parts)) or None
    elif path_style:
        out["addressing_style"] = "path"
        out["key"] = redact_text("/".join(path_parts[1:])) or None
    else:
        # Custom / unknown endpoint: don't guess which segment is the bucket —
        # keep the FULL path so the key is never silently truncated.
        out["addressing_style"] = None
        out["key"] = redact_text("/".join(path_parts)) or None
    out["problems"] = problems
    return out


# --- ListParts (one stuck multipart upload's parts — read-only, no abort) -----


def list_upload_parts(
    conn: sqlite3.Connection, provider_id: str, bucket: str, key: str,
    upload_id: str, max_parts: int = 1000, part_number_marker: int | None = None,
) -> dict[str, Any]:
    """List the PARTS of one in-progress multipart upload (read-only ListParts).

    list_multipart_uploads shows THAT uploads are stuck; this shows how much a
    specific one is holding — parts uploaded, bytes accrued, last activity — the
    concrete "this abandoned upload holds N GB" evidence. Listing only; aborting
    is a mutation and is NOT available (propose a lifecycle rule instead).
    """
    base = {
        "success": False, "part_count": 0, "total_bytes": 0,
        "first_part_at": None, "last_part_at": None, "sample_parts": [],
        "is_truncated": False, "next_part_number_marker": None,
        "error_code": None, "error_message_sanitized": None,
    }
    clamped = max(1, min(int(max_parts), 1000))
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        kw: dict[str, Any] = {"Bucket": bucket, "Key": key, "UploadId": upload_id,
                              "MaxParts": clamped}
        if part_number_marker:
            kw["PartNumberMarker"] = int(part_number_marker)
        resp = client.list_parts(**kw)
    except ClientError as exc:
        if _is_unsupported(exc):
            return {**base, "success": True, "parts_status": PROVIDER_UNSUPPORTED}
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}
    parts = resp.get("Parts", []) or []
    times = [p.get("LastModified") for p in parts if p.get("LastModified") is not None]
    iso = lambda d: d.isoformat() if hasattr(d, "isoformat") else d  # noqa: E731
    return {
        **base, "success": True, "parts_status": AVAILABLE,
        "part_count": len(parts),
        "total_bytes": sum(int(p.get("Size") or 0) for p in parts),
        "first_part_at": iso(min(times)) if times else None,
        "last_part_at": iso(max(times)) if times else None,
        "sample_parts": [{"part_number": p.get("PartNumber"), "size": p.get("Size"),
                          "last_modified": iso(p.get("LastModified"))}
                         for p in parts[:SAMPLE_KEYS_LIMIT]],
        "is_truncated": bool(resp.get("IsTruncated", False)),
        "next_part_number_marker": resp.get("NextPartNumberMarker"),
    }


# --- Conditional-read probe (ETag freshness — no body either way) ------------


def test_conditional_get(
    conn: sqlite3.Connection, provider_id: str, bucket: str, key: str, etag: str,
) -> dict[str, Any]:
    """HeadObject with If-None-Match — proves whether a cached ETag still matches
    the stored object (304 = unchanged, 200 = changed + the current ETag). The
    cleanest evidence for "am I seeing stale data / did the object change?", and
    a provider-compat probe for conditional-header support. No body either way.
    """
    base = {
        "success": False, "etag_matches": None, "current_etag": None,
        "status_code": None, "error_code": None, "error_message_sanitized": None,
    }
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        resp = client.head_object(Bucket=bucket, Key=key, IfNoneMatch=etag)
        # 200 does NOT always mean "changed": many S3-compatible providers simply
        # ignore If-None-Match on HEAD and return 200 with the SAME ETag. Compare
        # (quote-normalized — S3 returns ETags quoted, callers often pass them
        # bare) instead of blindly reporting a change: equal ETags on a 200 mean
        # the provider ignored the conditional header — a capability gap (rule
        # 18), not a stale/changed object.
        current = resp.get("ETag")
        matches = (current or "").strip('"') == (etag or "").strip('"')
        if matches:
            return {**base, "success": True, "etag_matches": True,
                    "current_etag": current, "status_code": 200,
                    "error_code": PROVIDER_UNSUPPORTED,
                    "error_message_sanitized":
                        "Provider ignored If-None-Match (returned 200 with the same "
                        "ETag instead of 304); conditional requests unsupported."}
        return {**base, "success": True, "etag_matches": False,
                "current_etag": current, "status_code": 200}
    except ClientError as exc:
        fields = _client_error_fields(exc)
        if fields.get("status_code") == 304 or fields.get("error_code") in ("304", "NotModified"):
            return {**base, "success": True, "etag_matches": True, "status_code": 304}
        if _is_unsupported(exc):
            return {**base, "success": True, "etag_matches": None,
                    "status_code": fields.get("status_code"),
                    "error_code": PROVIDER_UNSUPPORTED}
        return {**base, **fields, "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}
