"""Read-only storage tools: probes and object forensics (v5 registry).

Every function is a thin, typed front over the ``s3`` engine. Scope, bounds,
timeouts, redaction, the untrusted envelope and recording are the registry's
job; the few per-turn budgets (previews, latency runs, ranged reads) are
declared here with ``ctx.budget``.

``provider_id`` comes last and is optional: with one storage account the
registry fills it in; with several, the scope check asks for it.
"""

from __future__ import annotations

from typing import Any, Literal

from ...s3 import tools as s3
from .registry import Scope, current, plural, tool

_BUCKET = Scope()
_KEY = Scope(key="key")
_LIST = Scope(prefix="prefix", listing=True)


def _page_summary(res: Any) -> str:
    if not isinstance(res, dict) or res.get("success") is False:
        return str((res or {}).get("error_code") or "failed")
    n = int(res.get("key_count", len(res.get("keys") or [])) or 0)
    more = ", more to page" if res.get("next_token") or res.get("is_truncated") else ""
    return plural(n, "key") + more


@tool(group="core", core=True, scope=Scope(bucket=None), timeout=30)
def list_buckets(provider_id: str = "") -> dict[str, Any]:
    """List the buckets the account's credentials can see; also the first check of whether the keys work
    (AccessDenied: they authenticate but may not list; provider_unsupported: a capability gap).
    """
    return s3.list_buckets(current().conn(), provider_id)


@tool(group="core", core=True, scope=_BUCKET, timeout=30)
def head_bucket(bucket: str, provider_id: str = "") -> dict[str, Any]:
    """Check that a bucket exists and is reachable.
    """
    return s3.head_bucket(current().conn(), provider_id, bucket)


@tool(group="probes", scope=_BUCKET, timeout=30)
def get_bucket_location(bucket: str, provider_id: str = "") -> dict[str, Any]:
    """The bucket's real region versus the configured one; the first check for 301 redirects and region
    errors.
    """
    return s3.get_bucket_location(current().conn(), provider_id, bucket)


@tool(group="probes", scope=_BUCKET, timeout=45)
def test_addressing_style(bucket: str, provider_id: str = "") -> dict[str, Any]:
    """Probe virtual-hosted versus path-style addressing and say which works (SignatureDoesNotMatch or
    "bucket not found" on S3-compatible endpoints).
    """
    return s3.test_path_style_vs_virtual_host(current().conn(), provider_id, bucket)


@tool(group="probes", scope=Scope(bucket=None), timeout=30)
def inspect_endpoint_tls(provider_id: str = "") -> dict[str, Any]:
    """The endpoint's TLS certificate and protocol, for handshake, expiry and hostname errors.
    """
    from ...providers import clouds
    cloud = clouds.get(current().conn(), provider_id)
    if cloud is None or not cloud.endpoint_url:
        return {"success": False, "error_code": "no_endpoint",
                "error_message_sanitized": "This provider uses the default AWS endpoint."}
    return s3.inspect_tls(cloud.endpoint_url)


@tool(group="probes", scope=Scope(key="key"), timeout=60, bounds={"samples": (1, 10)})
def measure_request_latency(bucket: str, key: str = "", samples: int = 5,
                            provider_id: str = "") -> dict[str, Any]:
    """Time a few HEAD round-trips to the bucket (or one key): min, p50, p95 and max in ms.

    Args:
        key: Probe this object instead of the bucket.
        samples: Round-trips (1-10).
    """
    ctx = current()
    if not ctx.budget("runs", 8):
        return {"error": "Latency-probe budget for this turn is used up (8 runs). Report what you measured."}
    return s3.measure_request_latency(ctx.conn(), provider_id, bucket, key or None, samples)


@tool(group="probes", untrusted=True, timeout=10)
def diagnose_presigned_url(url: str) -> dict[str, Any]:
    """Parse a pasted presigned URL (no request is made): signature version, expiry, credential scope,
    signed headers and the problems found.

    Args:
        url: The full presigned URL.
    """
    return s3.diagnose_presigned_url(url)


@tool(group="objects", scope=_LIST, timeout=60, bounds={"max_keys": (1, 1000)}, summarize=_page_summary)
def list_objects(bucket: str, prefix: str = "", max_keys: int = 200, continuation_token: str = "",
                 recursive: bool = False, provider_id: str = "") -> dict[str, Any]:
    """One page of object keys (no bodies). Page with next_token: one page is not the bucket total. For a
    very large bucket, prefer an inventory.

    Args:
        max_keys: Page size (up to 1000).
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
def list_object_versions(bucket: str, prefix: str = "", max_keys: int = 1000, key_marker: str = "",
                         version_id_marker: str = "", provider_id: str = "") -> dict[str, Any]:
    """One page of object versions and delete markers: counts, current versus noncurrent bytes (why a
    versioned bucket is large).

    Args:
        max_keys: Page size (up to 1000).
    """
    return s3.list_object_versions(current().conn(), provider_id, bucket, prefix or None, max_keys,
                                   key_marker=key_marker or None, version_id_marker=version_id_marker or None)


@tool(group="objects", scope=_LIST, timeout=60, bounds={"max_uploads": (1, 1000)})
def list_multipart_uploads(bucket: str, prefix: str = "", max_uploads: int = 1000, key_marker: str = "",
                           upload_id_marker: str = "", provider_id: str = "") -> dict[str, Any]:
    """One page of incomplete multipart uploads (billed, invisible in a listing): count, oldest, samples.

    Args:
        max_uploads: Page size (up to 1000).
    """
    return s3.list_multipart_uploads(current().conn(), provider_id, bucket, max_uploads, prefix or None,
                                     key_marker=key_marker or None, upload_id_marker=upload_id_marker or None)


@tool(group="objects", scope=_KEY, timeout=45, bounds={"max_parts": (1, 1000)})
def list_upload_parts(bucket: str, key: str, upload_id: str, max_parts: int = 1000,
                      part_number_marker: int = 0, provider_id: str = "") -> dict[str, Any]:
    """One page of an in-progress multipart upload's parts: count, bytes, first and last part times.

    Args:
        key: The upload's object key.
        upload_id: From list_multipart_uploads.
        max_parts: Page size (up to 1000).
    """
    return s3.list_upload_parts(current().conn(), provider_id, bucket, key, upload_id, max_parts,
                                part_number_marker=part_number_marker or None)


ObjectAspect = Literal["head", "attributes", "lock", "acl", "tags"]
_OBJECT_ASPECTS = {"head": "head_object", "attributes": "get_object_attributes",  # s3 engine reads
                   "lock": "get_object_lock_status", "acl": "get_object_acl", "tags": "get_object_tagging"}


@tool(group="objects", scope=_KEY, timeout=60)
def inspect_object(bucket: str, key: str, version_id: str = "", aspects: list[ObjectAspect] | None = None,
                   provider_id: str = "") -> dict[str, Any]:
    """One object's metadata without its body. head (the default): size, ETag, class, metadata, restore and
    replication status; attributes: checksums, parts; lock: retention, legal hold; acl: is this object
    public; tags.

    Args:
        aspects: Which reads to make.
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
def test_object_read(bucket: str, key: str, mode: Literal["conditional", "range"], etag: str = "",
                     range_header: str = "bytes=0-1023", provider_id: str = "") -> dict[str, Any]:
    """conditional: does a cached ETag still match the object (stale data; read etag_matches)? range: a
    bounded ranged GET checking range support and latency.

    Args:
        mode: Which read to test.
        etag: For conditional: the cached ETag.
        range_header: For range: e.g. bytes=0-1023.
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
def preview_object(bucket: str, key: str, max_bytes: int = 262144, provider_id: str = "") -> dict[str, Any]:
    """A redacted preview of an object's first bytes (at most 1 MiB; gzip decompressed, parquet as its
    structure, binary reported). A few objects per turn.

    Args:
        max_bytes: Bytes to read.
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
