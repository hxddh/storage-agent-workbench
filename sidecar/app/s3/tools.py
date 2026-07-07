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
import zlib
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
_UNSUPPORTED_CODES = {"NotImplemented", "MethodNotAllowed"}
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
            # A bucket name is a DNS-style resource identifier, not secret
            # material — and account discovery reuses it verbatim as the
            # `Bucket=` argument for head_bucket / config snapshots. Running it
            # through redact_text can mangle a legitimately-named bucket (e.g.
            # one that trips a token-shaped pattern) into "***REDACTED***", which
            # then makes every per-bucket follow-up call fail. Keep the raw name;
            # secrets in error messages/headers are still redacted elsewhere.
            buckets.append({
                "name": str(b.get("Name") or ""),
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
        "sample_keys": [], "is_truncated": False,
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
            "is_truncated": bool(resp.get("IsTruncated", False)),
            "next_key_marker": resp.get("NextKeyMarker"),
            "next_version_id_marker": resp.get("NextVersionIdMarker"),
        }
    except ClientError as exc:
        return {**base, **_client_error_fields(exc), "success": False}
    except Exception as exc:  # noqa: BLE001
        return {**base, **_generic_error_fields(exc), "success": False}


# --- 3c. list_multipart_uploads ---------------------------------------------


def list_multipart_uploads(
    conn: sqlite3.Connection,
    provider_id: str,
    bucket: str,
    max_uploads: int = MAX_LIST_KEYS,
    key_marker: str | None = None,
    upload_id_marker: str | None = None,
) -> dict[str, Any]:
    """Bounded ListMultipartUploads — surfaces incomplete/abandoned multipart
    uploads (a common silent cost leak: parts are billed but invisible in a normal
    object listing). Read-only; listing only — aborting is a mutation and is out.
    """
    base = {
        "success": False, "upload_count": 0, "oldest_initiated": None,
        "sample_keys": [], "is_truncated": False,
        "next_key_marker": None, "next_upload_id_marker": None,
        "error_code": None, "error_message_sanitized": None,
    }
    clamped = max(1, min(int(max_uploads), MAX_LIST_KEYS))
    try:
        client = client_factory.build_s3_client(conn, provider_id)
        kw: dict[str, Any] = {"Bucket": bucket, "MaxUploads": clamped}
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
        # Server-side encryption state: the security skill needs this to reason
        # about "why can't I read this object" (KMS-encrypted objects require key
        # access). The KMS key id is reduced to its last segment (alias/key-id) so
        # no account id / full ARN leaks; the value is redacted defensively.
        sse = resp.get("ServerSideEncryption")
        kms_key = resp.get("SSEKMSKeyId")
        kms_key_ref = redact(str(kms_key).split("/")[-1].split(":")[-1]) if kms_key else None
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
        return {**base, "success": True, "content": text, "bytes_read": len(data),
                "object_size": object_size, "content_type": ctype or None, "truncated": truncated}
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
        "success": False, "operation": op, "samples_requested": n,
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
    # Real S3 returns `InvalidRequest` ("Bucket is missing Object Lock
    # Configuration") from get_object_retention/legal_hold on a bucket without
    # Object Lock — the overwhelmingly common case — so treat it as "none" here
    # (these two calls are object-lock-specific) rather than a confusing hard error.
    _NONE_CODES = {
        "NoSuchObjectLockConfiguration",
        "ObjectLockConfigurationNotFoundError",
        "InvalidRequest",
    }
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
        if code in _NONE_CODES:
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
        if code in _NONE_CODES:
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
