"""Read-only storage tools: probes and object forensics (v5 registry).

Every function is a thin, typed front over the ``s3`` engine. Scope, bounds,
timeouts, redaction, the untrusted envelope and recording are the registry's
job; the few per-turn budgets (previews, latency runs, ranged reads) are
declared here with ``ctx.budget``.
"""

from __future__ import annotations

from typing import Any

from ...s3 import tools as s3
from .registry import Scope, current, tool

_BUCKET = Scope()
_KEY = Scope(key="key")
_LIST = Scope(prefix="prefix", listing=True)


def _page_summary(res: Any) -> str:
    if not isinstance(res, dict) or res.get("success") is False:
        return str((res or {}).get("error_code") or "failed")
    n = res.get("key_count", len(res.get("keys") or []))
    more = " · more" if res.get("next_token") or res.get("is_truncated") else ""
    return f"{n} keys{more}"


@tool(group="core", core=True, scope=Scope(bucket=None), timeout=30)
def list_buckets(provider_id: str) -> dict[str, Any]:
    """List every bucket the provider's credentials can see (read-only ListBuckets). Also the first step
    for any credentials, 403 or SignatureDoesNotMatch diagnosis: success means the keys work;
    InvalidAccessKeyId / SignatureDoesNotMatch mean the keys or signing are wrong; AccessDenied means the
    keys authenticate but may not ListBuckets; provider_unsupported is a capability gap, not bad keys.

    Args:
        provider_id: A provider_id from configured_providers.
    """
    return s3.list_buckets(current().conn(), provider_id)


@tool(group="core", core=True, scope=_BUCKET, timeout=30)
def head_bucket(provider_id: str, bucket: str) -> dict[str, Any]:
    """Check that a bucket exists and is reachable (read-only HeadBucket).

    Args:
        provider_id: The provider.
        bucket: The bucket name.
    """
    return s3.head_bucket(current().conn(), provider_id, bucket)


@tool(group="probes", scope=_BUCKET, timeout=30)
def get_bucket_location(provider_id: str, bucket: str) -> dict[str, Any]:
    """Where does this bucket actually live? One read-only GetBucketLocation. Use first for any
    endpoint/region symptom (301 PermanentRedirect, AuthorizationHeaderMalformed naming a region, a
    SignatureDoesNotMatch on one bucket only). Returns bucket_region, the configured region and endpoint,
    and region_mismatch.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
    """
    return s3.get_bucket_location(current().conn(), provider_id, bucket)


@tool(group="probes", scope=_BUCKET, timeout=45)
def test_addressing_style(provider_id: str, bucket: str) -> dict[str, Any]:
    """Probe virtual-hosted vs path-style addressing (two read-only HeadBucket calls) and recommend which
    works. Key for SignatureDoesNotMatch and 'bucket not found' on S3-compatible providers.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
    """
    return s3.test_path_style_vs_virtual_host(current().conn(), provider_id, bucket)


@tool(group="probes", scope=Scope(bucket=None), timeout=30)
def inspect_endpoint_tls(provider_id: str) -> dict[str, Any]:
    """Inspect the provider endpoint's TLS certificate (version, subject, issuer, validity) over a read-only
    connection. For handshake, expired-certificate and hostname-mismatch errors.

    Args:
        provider_id: The provider.
    """
    from ...providers import clouds
    cloud = clouds.get(current().conn(), provider_id)
    if cloud is None or not cloud.endpoint_url:
        return {"success": False, "error_code": "no_endpoint",
                "error_message_sanitized": "This provider uses the default AWS endpoint."}
    return s3.inspect_tls(cloud.endpoint_url)


@tool(group="probes", scope=Scope(key="key"), timeout=60, bounds={"samples": (1, 10)})
def measure_request_latency(provider_id: str, bucket: str, key: str = "", samples: int = 5) -> dict[str, Any]:
    """Measure live request latency — turns "it's slow" into numbers. A bounded number of lightweight
    round-trips (HeadBucket, or HeadObject when key is given; no bodies); returns min/p50/p95/max/mean ms.
    Bounded per turn: a diagnostic probe, not a load test.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        key: Optional object key to probe instead of the bucket.
        samples: Round-trips to time (1-10).
    """
    ctx = current()
    if not ctx.budget("runs", 8):
        return {"error": "Latency-probe budget for this turn is used up (8 runs). Report what you measured."}
    return s3.measure_request_latency(ctx.conn(), provider_id, bucket, key or None, samples)


@tool(group="probes", untrusted=True, timeout=10)
def diagnose_presigned_url(url: str) -> dict[str, Any]:
    """Diagnose a presigned URL the user pasted — pure parsing, no network request, no credential echoed.
    Extracts signature version, whether it is expired, the credential scope (date/region/service),
    signed headers, addressing style and a problems list (url_expired, clock skew, v4 7-day max, …).

    Args:
        url: The full presigned URL.
    """
    return s3.diagnose_presigned_url(url)


@tool(group="objects", scope=_LIST, timeout=60, bounds={"max_keys": (1, 1000)}, summarize=_page_summary)
def list_objects(provider_id: str, bucket: str, prefix: str = "", max_keys: int = 200,
                 continuation_token: str = "", recursive: bool = False) -> dict[str, Any]:
    """List one page of object keys (read-only ListObjectsV2, up to 1000 per call; no bodies). To enumerate
    fully, page with continuation_token = the previous next_token until it is null — one page's key_count
    is never the bucket total. `objects` carries size / storage_class / last_modified for the first 100
    keys positionally. recursive=true lists flat (no '/' grouping). For a very large bucket, propose an
    inventory analysis instead of paging forever.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        prefix: Only keys under this prefix (required on a prefix-scoped provider).
        max_keys: Page size, up to 1000.
        continuation_token: The previous page's next_token.
        recursive: List flat instead of grouping by '/'.
    """
    res = s3.list_objects_v2(current().conn(), provider_id, bucket, max_keys, prefix or None,
                             continuation_token=continuation_token or None,
                             delimiter=None if recursive else "/")
    if isinstance(res, dict):
        keys = res.get("keys")
        sample = res.get("sample_keys")
        if isinstance(keys, list) and isinstance(sample, list) and keys[:len(sample)] == sample:
            res.pop("sample_keys", None)
    return res


@tool(group="objects", scope=_LIST, timeout=60, bounds={"max_keys": (1, 1000)})
def list_object_versions(provider_id: str, bucket: str, prefix: str = "", max_keys: int = 1000,
                         key_marker: str = "", version_id_marker: str = "") -> dict[str, Any]:
    """List one page of object versions and delete markers (read-only; no bodies) — the answer to "why is
    my versioned bucket so large?". Returns version / noncurrent / delete-marker counts, current vs
    noncurrent bytes, sample keys, and the markers for the next page (counts are one page when truncated).

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        prefix: Only keys under this prefix.
        max_keys: Page size, up to 1000.
        key_marker: Next-page key marker.
        version_id_marker: Next-page version id marker.
    """
    return s3.list_object_versions(current().conn(), provider_id, bucket, prefix or None, max_keys,
                                   key_marker=key_marker or None, version_id_marker=version_id_marker or None)


@tool(group="objects", scope=_LIST, timeout=60, bounds={"max_uploads": (1, 1000)})
def list_multipart_uploads(provider_id: str, bucket: str, prefix: str = "", max_uploads: int = 1000,
                           key_marker: str = "", upload_id_marker: str = "") -> dict[str, Any]:
    """List one page of incomplete multipart uploads (read-only) — billed but invisible in a normal listing.
    Returns the count, the oldest initiation time, sample keys and next-page markers. Aborting is a
    mutation and does not exist here: propose an AbortIncompleteMultipartUpload lifecycle rule instead.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        prefix: Only keys under this prefix (required on a prefix-scoped provider).
        max_uploads: Page size, up to 1000.
        key_marker: Next-page key marker.
        upload_id_marker: Next-page upload id marker.
    """
    return s3.list_multipart_uploads(current().conn(), provider_id, bucket, max_uploads, prefix or None,
                                     key_marker=key_marker or None, upload_id_marker=upload_id_marker or None)


@tool(group="objects", scope=_KEY, timeout=45, bounds={"max_parts": (1, 1000)})
def list_upload_parts(provider_id: str, bucket: str, key: str, upload_id: str, max_parts: int = 1000,
                      part_number_marker: int = 0) -> dict[str, Any]:
    """List the parts of one in-progress multipart upload (read-only ListParts): part count, bytes accrued,
    first/last part times. One page when truncated — page before quoting total_bytes.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        key: The object key of the upload.
        upload_id: From list_multipart_uploads.
        max_parts: Page size, up to 1000.
        part_number_marker: Next-page marker.
    """
    return s3.list_upload_parts(current().conn(), provider_id, bucket, key, upload_id, max_parts,
                                part_number_marker=part_number_marker or None)


_OBJECT_ASPECTS = {"head": "head_object", "attributes": "get_object_attributes",  # s3 engine reads
                   "lock": "get_object_lock_status", "acl": "get_object_acl", "tags": "get_object_tagging"}


@tool(group="objects", scope=_KEY, timeout=60)
def inspect_object(provider_id: str, bucket: str, key: str, version_id: str = "",
                   aspects: list[str] | None = None) -> dict[str, Any]:
    """Read one object's metadata without its body (read-only). aspects picks the reads; the default is
    head alone (one HeadObject). head: size, ETag, last-modified, storage class, sanitized user metadata,
    replication / restore / archive status, parts count, lifecycle expiration, version id, content
    headers. attributes: checksum algorithm, part count, storage class, size (GetObjectAttributes; not
    every S3-compatible provider has it — provider_unsupported → use head). lock: Object-Lock retention
    mode, retain-until date, legal hold — for "why can't I delete or overwrite this object?". acl: for
    "is THIS object public?" (an object can be public under a locked-down bucket; grantees reduced to a
    kind, a public grant sets is_public). tags: the tag set (redacted, at most 20) that drives lifecycle
    rules, cost attribution and tag-based policies. An unsupported aspect reports provider_unsupported.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        key: The object key.
        version_id: A specific version to read.
        aspects: Any of head, attributes, lock, acl, tags (default: head).
    """
    wanted = aspects or ["head"]
    unknown = sorted(set(wanted) - set(_OBJECT_ASPECTS))
    if unknown:
        return {"error": f"Unknown aspect {', '.join(unknown)}. Use any of: {', '.join(_OBJECT_ASPECTS)}."}
    chosen = [a for a in _OBJECT_ASPECTS if a in wanted]
    ctx = current()
    if len(chosen) == 1:  # one read answers as that read does
        return getattr(s3, _OBJECT_ASPECTS[chosen[0]])(ctx.conn(), provider_id, bucket, key, version_id or None)
    out: dict[str, Any] = {"bucket": bucket, "key": key}
    for name in chosen:
        if ctx.cancelled:
            out["stopped"] = True
            break
        out[name] = getattr(s3, _OBJECT_ASPECTS[name])(ctx.conn(), provider_id, bucket, key, version_id or None)
    reads = [v for k, v in out.items() if k in _OBJECT_ASPECTS and isinstance(v, dict)]
    out["success"] = any(r.get("success") is not False for r in reads)
    return out


@tool(group="objects", scope=_KEY, timeout=45)
def test_object_read(provider_id: str, bucket: str, key: str, mode: str, etag: str = "",
                     range_header: str = "bytes=0-1023") -> dict[str, Any]:
    """Test how one object reads (read-only). mode "conditional": does a cached ETag still match the
    stored object? HeadObject with If-None-Match, no body — read `etag_matches`, not the status code; a
    provider that ignores If-None-Match reports provider_unsupported. For "I'm seeing stale data".
    mode "range": a bounded ranged GET (reads at most the requested bytes) that verifies range support
    and partial-read latency; at most 12 per turn.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        key: The object key.
        mode: "conditional" or "range".
        etag: For conditional: the cached ETag (quotes optional).
        range_header: For range: the Range header, e.g. bytes=0-1023.
    """
    ctx = current()
    if mode == "conditional":
        if not etag:
            return {"error": "mode conditional needs the cached etag."}
        return s3.test_conditional_get(ctx.conn(), provider_id, bucket, key, etag)
    if mode != "range":
        return {"error": 'Unknown mode. Use "conditional" or "range".'}
    if not ctx.budget("reads", 12):
        return {"error": "Ranged-read budget for this turn is used up (12 calls)."}
    return s3.test_range_get(ctx.conn(), provider_id, bucket, key, range_header or "bytes=0-1023")


_PREVIEW_BYTES = 24 * 1024 * 1024


@tool(group="objects", scope=_KEY, timeout=60, bounds={"max_bytes": (1024, 1024 * 1024)})
def preview_object(provider_id: str, bucket: str, key: str, max_bytes: int = 262144) -> dict[str, Any]:
    """Read a bounded, sanitized preview of one object's content (its first bytes, at most 1 MiB) — a
    manifest, a small config, a sample of a log. Gzip is decompressed within the bound; parquet returns its
    structure only. Binary content is reported, not decoded; secrets are redacted. A few objects per turn,
    never a bulk download.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        key: The object key.
        max_bytes: Bytes to read (default 256 KiB, at most 1 MiB).
    """
    ctx = current()
    left = ctx.remaining("bytes", _PREVIEW_BYTES)
    if left <= 0:
        return {"error": "Object-preview byte budget for this turn is used up (24 MiB)."}
    if not ctx.budget("objects", 16):
        return {"error": "Object-preview budget for this turn is used up (16 objects)."}
    # The read itself is clamped to what is left, so the budget bounds bytes read — not just reported.
    res = s3.preview_object(ctx.conn(), provider_id, bucket, key, min(max_bytes, left))
    if isinstance(res, dict):
        ctx.budget("bytes", _PREVIEW_BYTES, min(left, int(res.get("bytes_read") or 0)))
    return res
