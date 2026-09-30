"""Read-only storage tools: buckets, endpoint probes, listings, one object (v10).

Every function is a thin, typed front over the ``s3`` engine — one tool per
job, the mode picked by an enum. Scope, bounds, timeouts, redaction, the
untrusted envelope and recording are the registry's job; the per-turn budgets
(previews, ranged reads, latency runs) are spent here with ``ctx.budget``.

``provider_id`` comes last and is optional: with one storage account the
registry fills it in; with several, the scope check asks for it.
"""

from __future__ import annotations

import json
from typing import Any, Literal

from ...s3 import tools as s3
from .registry import Scope, current, plural, tool

_KEY = Scope(key="key")
_LIST = Scope(prefix="prefix", listing=True)

# Response headers that say nothing about the storage (routing, dates, request
# identity): dropped from what the model and the UI read.
_NOISY_HEADERS = frozenset({"server", "date", "x-amz-request-id", "x-amz-id-2", "connection", "content-length",
                            "keep-alive", "x-amz-server-side-encryption-customer-algorithm",
                            "x-minio-deployment-id", "x-xss-protection", "strict-transport-security",
                            "x-content-type-options", "vary", "accept-ranges"})


def quiet(res: Any) -> Any:
    """An engine result without its noise: no host id, no request ids on a
    success, no routing headers. A failure keeps its request id (support asks)."""
    if isinstance(res, list):
        return [quiet(x) for x in res]
    if not isinstance(res, dict):
        return res
    out: dict[str, Any] = {}
    failed = res.get("success") is False
    for k, v in res.items():
        if k == "host_id" or (k == "request_id" and (not failed or v is None)):
            continue
        if k == "headers_sanitized" and isinstance(v, dict):
            kept = {h: hv for h, hv in v.items() if str(h).lower() not in _NOISY_HEADERS}
            if kept:
                out[k] = kept
            continue
        out[k] = quiet(v) if isinstance(v, (dict, list)) else v
    return out


def _list_buckets_summary(res: Any) -> str:
    if not isinstance(res, dict) or res.get("success") is False:
        return str((res or {}).get("error_code") or (res or {}).get("status") or "failed")
    return plural(len(res.get("buckets") or []), "bucket")


@tool(group="core", core=True, scope=Scope(bucket=None), timeout=30, summarize=_list_buckets_summary)
def list_buckets(provider_id: str = "") -> dict[str, Any]:
    """List the buckets the account's credentials can see; also the first check of whether the keys work
    (AccessDenied: they authenticate but may not list; provider_unsupported: a capability gap).
    """
    from ...providers import clouds
    ctx = current()
    res = quiet(s3.list_buckets(ctx.conn(), provider_id))
    cloud = clouds.get(ctx.conn(), provider_id)
    allowed = set(cloud.allowed_buckets or ()) if cloud else set()
    if allowed and isinstance(res, dict) and isinstance(res.get("buckets"), list):
        # A bucket-scoped account sees only its scope, here as everywhere else.
        res["buckets"] = [b for b in res["buckets"] if b.get("name") in allowed]
        res["bucket_count"] = len(res["buckets"])
        res["scope"] = "filtered to this account's allowed_buckets"
    return res


# --- probe_endpoint -------------------------------------------------------------------

Check = Literal["reach", "location", "addressing", "tls", "latency"]


def _probe_summary(res: Any) -> str:
    if not isinstance(res, dict):
        return "probed"
    if res.get("error"):
        return str(res["error"])
    check = res.get("check")
    if check == "latency" and res.get("success"):
        return f"p50 {res.get('p50_ms')} ms, p95 {res.get('p95_ms')} ms"
    if check == "location" and res.get("success"):
        return f"region {res.get('bucket_region')}" + (", mismatch" if res.get("region_mismatch") else "")
    if check == "addressing":
        return f"addressing: {res.get('recommendation') or 'inconclusive'}"
    if check == "tls":
        return str(res.get("tls_version") or res.get("error_code") or "no TLS answer")
    if res.get("success") is False:
        return str(res.get("error_code") or "failed")
    return "reachable" if check == "reach" else "done"


@tool(group="probes", scope=_KEY, timeout=60, bounds={"samples": (1, 10)}, summarize=_probe_summary)
def probe_endpoint(bucket: str = "", check: Check = "reach", key: str = "", samples: int = 5,
                   provider_id: str = "") -> dict[str, Any]:
    """Probe the endpoint: reach (HeadBucket), location (real vs configured region), addressing (virtual-
    hosted vs path-style), tls (certificate; no bucket) or latency (HEAD round-trips in ms).

    Args:
        key: latency: this object instead of the bucket.
        samples: latency: round-trips (1-10).
    """
    ctx = current()
    conn = ctx.conn()
    if check == "tls":
        from ...providers import clouds
        cloud = clouds.get(conn, provider_id)
        if cloud is None or not cloud.endpoint_url:
            return {"check": check, "success": False, "error_code": "no_endpoint",
                    "error_message_sanitized": "This account uses the default AWS endpoint."}
        return {"check": check, **s3.inspect_tls(cloud.endpoint_url)}
    if check not in ("reach", "location", "addressing", "latency"):
        return {"error": "Unknown check. Use reach, location, addressing, tls or latency."}
    if not bucket:
        return {"error": f"check {check} needs a bucket."}
    if check == "reach":
        res = s3.head_bucket(conn, provider_id, bucket)
    elif check == "location":
        res = s3.get_bucket_location(conn, provider_id, bucket)
    elif check == "addressing":
        res = s3.test_path_style_vs_virtual_host(conn, provider_id, bucket)
    else:
        if not ctx.budget("runs", 8):
            return {"error": "Latency-probe budget for this turn is used up (8 runs). Report what you measured."}
        res = s3.measure_request_latency(conn, provider_id, bucket, key or None, samples)
    return {"check": check, **quiet(res)}


# --- list_objects ------------------------------------------------------------------------

ListKind = Literal["keys", "versions", "uploads"]


def _page_summary(res: Any) -> str:
    if not isinstance(res, dict) or res.get("success") is False:
        return str((res or {}).get("error") or (res or {}).get("error_code") or "failed")
    more = ", more to page" if res.get("next_token") or res.get("is_truncated") else ""
    kind = res.get("kind")
    if kind == "versions":
        return plural(int(res.get("version_count") or 0), "version") + more
    if kind == "uploads":
        return plural(int(res.get("upload_count") or 0), "open upload") + more
    n = int(res.get("key_count", len(res.get("keys") or [])) or 0)
    return plural(n, "key") + more


def _markers(page_token: str) -> tuple[str | None, str | None]:
    """versions / uploads page with two markers, carried as one opaque token."""
    if not page_token:
        return None, None
    try:
        pair = json.loads(page_token)
    except ValueError:
        return page_token, None
    if isinstance(pair, list) and len(pair) == 2:
        return (str(pair[0]) if pair[0] else None), (str(pair[1]) if pair[1] else None)
    return page_token, None


def _token(a: Any, b: Any) -> str | None:
    return json.dumps([a or "", b or ""]) if (a or b) else None


@tool(group="objects", scope=_LIST, timeout=60, bounds={"max_keys": (1, 1000)}, summarize=_page_summary)
def list_objects(bucket: str, kind: ListKind = "keys", prefix: str = "", max_keys: int = 200,
                 page_token: str = "", recursive: bool = False, provider_id: str = "") -> dict[str, Any]:
    """One page of a listing, no bodies: keys (size, class, age), versions (delete markers, noncurrent
    bytes) or uploads (incomplete multipart uploads, with upload ids). A page is not the bucket total.

    Args:
        max_keys: Page size (1-1000).
        page_token: The previous page's next_token.
        recursive: keys: flat, not grouped by '/'.
    """
    conn = current().conn()
    if kind == "versions":
        km, vm = _markers(page_token)
        res = quiet(s3.list_object_versions(conn, provider_id, bucket, prefix or None, max_keys,
                                            key_marker=km, version_id_marker=vm))
        res.pop("sample_keys", None)  # sample_versions carries every key it names
        res["next_token"] = _token(res.pop("next_key_marker", None), res.pop("next_version_id_marker", None))
    elif kind == "uploads":
        km, um = _markers(page_token)
        res = quiet(s3.list_multipart_uploads(conn, provider_id, bucket, max_keys, prefix or None,
                                              key_marker=km, upload_id_marker=um))
        res.pop("sample_keys", None)  # sample_uploads carries the keys with their upload ids
        res["next_token"] = _token(res.pop("next_key_marker", None), res.pop("next_upload_id_marker", None))
    elif kind == "keys":
        res = quiet(s3.list_objects_v2(conn, provider_id, bucket, max_keys, prefix or None,
                                       continuation_token=page_token or None, delimiter=None if recursive else "/"))
        res.pop("sample_keys", None)  # the first keys of `keys`
        objects, keys = res.get("objects") or [], res.get("keys") or []
        if keys and len(keys) <= len(objects):
            res.pop("keys", None)  # every key is already in `objects`, with its detail
        elif keys:
            res["keys"] = keys[len(objects):]
            res["keys_note"] = f"The first {len(objects)} keys are in objects; keys lists the rest."
        if res.get("max_keys_requested") == res.get("max_keys_applied"):
            res.pop("max_keys_requested", None)
            res.pop("max_keys_applied", None)
    else:
        return {"error": "Unknown kind. Use keys, versions or uploads."}
    return {"kind": kind, **res}


# --- inspect_object ---------------------------------------------------------------------

ObjectAspect = Literal["head", "attributes", "lock", "acl", "tags", "preview", "range", "conditional"]
_READS = {"head": "head_object", "attributes": "get_object_attributes",  # s3 engine reads
          "lock": "get_object_lock_status", "acl": "get_object_acl", "tags": "get_object_tagging"}
_ASPECTS = (*_READS, "preview", "range", "conditional")
_PREVIEW_BYTES = 24 * 1024 * 1024  # per turn
_PREVIEW_OBJECTS = 16  # per turn
_RANGE_READS = 12  # per turn


def _inspect_summary(res: Any) -> str:
    if not isinstance(res, dict):
        return "inspected"
    if res.get("error"):
        return str(res["error"])
    if res.get("partial"):
        return "partial: " + ", ".join(res.get("failed") or []) + " failed"
    if res.get("success") is False:
        return str(res.get("error_code") or "failed")
    if "size" in res and isinstance(res.get("size"), int):
        return plural(res["size"], "byte")
    return "inspected"


def _preview(ctx: Any, provider_id: str, bucket: str, key: str, kib: int) -> dict[str, Any]:
    left = ctx.remaining("bytes", _PREVIEW_BYTES)
    if left <= 0:
        return {"success": False, "error": "Object-preview byte budget for this turn is used up (24 MiB)."}
    if not ctx.budget("objects", _PREVIEW_OBJECTS):
        return {"success": False, "error": f"Object-preview budget for this turn is used up ({_PREVIEW_OBJECTS} "
                                           "objects)."}
    # The read itself is clamped to what is left, so the budget bounds bytes read — not just reported.
    res = s3.preview_object(ctx.conn(), provider_id, bucket, key, min(kib * 1024, left))
    if isinstance(res, dict):
        ctx.budget("bytes", _PREVIEW_BYTES, min(left, int(res.get("bytes_read") or 0)))
    return res


def _range(ctx: Any, provider_id: str, bucket: str, key: str, byte_range: str) -> dict[str, Any]:
    if not ctx.budget("reads", _RANGE_READS):
        return {"success": False, "error": f"Ranged-read budget for this turn is used up ({_RANGE_READS} calls)."}
    return s3.test_range_get(ctx.conn(), provider_id, bucket, key, byte_range or "bytes=0-1023")


@tool(group="objects", scope=_KEY, timeout=60, bounds={"preview_kib": (1, 1024)}, summarize=_inspect_summary)
def inspect_object(bucket: str, key: str, aspects: list[ObjectAspect] | None = None, version_id: str = "",
                   etag: str = "", byte_range: str = "bytes=0-1023", preview_kib: int = 256,
                   provider_id: str = "") -> dict[str, Any]:
    """One object. head (default): size, ETag, class, metadata, restore/replication; attributes: checksums,
    parts; lock; acl: is it public; tags; preview: first bytes, redacted; range: a ranged GET; conditional:
    does etag still match.

    Args:
        etag: conditional: the cached ETag.
        byte_range: range: at most 4 MiB.
        preview_kib: preview: KiB (1-1024).
    """
    wanted = aspects or ["head"]
    unknown = sorted({str(a) for a in wanted} - set(_ASPECTS))
    if unknown:
        return {"error": f"Unknown aspect {', '.join(unknown)}. Use any of: {', '.join(_ASPECTS)}."}
    if "conditional" in wanted and not etag:
        return {"error": "The conditional aspect needs the cached etag."}
    chosen = [a for a in _ASPECTS if a in wanted]
    ctx = current()

    def read(name: str) -> dict[str, Any]:
        if name == "preview":
            return _preview(ctx, provider_id, bucket, key, preview_kib)
        if name == "range":
            return _range(ctx, provider_id, bucket, key, byte_range)
        if name == "conditional":
            return s3.test_conditional_get(ctx.conn(), provider_id, bucket, key, etag)
        return getattr(s3, _READS[name])(ctx.conn(), provider_id, bucket, key, version_id or None)

    if len(chosen) == 1:  # one read answers as that read does
        return quiet(read(chosen[0]))
    out: dict[str, Any] = {"bucket": bucket, "key": key}
    for name in chosen:
        if ctx.cancelled:
            out["stopped"] = True
            break
        out[name] = quiet(read(name))
    failed = [n for n in chosen if isinstance(out.get(n), dict) and out[n].get("success") is False]
    done = [n for n in chosen if n in out]
    out["success"] = len(failed) < len(done)
    if failed:
        # A read that failed decides nothing: an unreadable ACL is not "not public".
        out["partial"] = True
        out["failed"] = failed
    return out
