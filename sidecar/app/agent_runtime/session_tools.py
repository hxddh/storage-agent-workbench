"""Read-only investigator tools for the in-chat agent.

The session agent uses these to investigate live: it chooses the provider and
bucket (unlike run-scoped tools, which are pinned). Every tool here is:

- READ-ONLY — no mutating/destructive S3 operation exists or is reachable;
- BOUNDED — object listing is clamped (``guardrails.bound_tool_args``);
- AUDITED — each call is recorded;
- SECRET-SAFE — credentials are resolved from the OS keychain *inside* the S3
  layer and never appear in arguments, results, or the model context;
- SCOPED — provider_id must be a configured provider, and a bucket must pass the
  provider's allow-list (if one is set).

Anything that moves data or runs a large/expensive job (evidence download,
inventory/access-log analysis, full scans) is NOT here — those remain explicit,
confirmed runs proposed as next steps.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Callable

from .. import audit
from ..repositories import cloud_providers as cloud_repo
from ..s3 import config_tools as ct
from ..s3 import tools as s3
from . import guardrails


def _err(msg: str) -> str:
    return json.dumps({"error": msg})


def _summarize(result: Any) -> str:
    if isinstance(result, dict):
        if result.get("error"):
            return "error"
        for key in ("buckets", "objects", "keys", "contents"):
            if isinstance(result.get(key), list):
                return f"{len(result[key])} {key}"
        if result.get("success") is False or result.get("error_code"):
            return "error"
    return "done"


def build(conn: sqlite3.Connection, function_tool: Callable, activity: list[dict[str, Any]] | None = None) -> list[Any]:
    """Build the read-only investigator tool set bound to this DB connection.

    If ``activity`` is given, each tool call appends a sanitized record
    {tool, target, result} for the UI to show ("ran list_buckets → 96 buckets").
    """
    def provider(provider_id: str):
        return cloud_repo.get(conn, provider_id)

    def provider_name(provider_id: str) -> str:
        p = cloud_repo.get(conn, provider_id)
        return p.name if p else provider_id[:8]

    def bucket_ok(p, bucket: str) -> bool:
        return (not p.allowed_buckets) or (bucket in p.allowed_buckets)

    def note(tool: str, target: str, result: Any) -> None:
        if activity is not None:
            summary = result if isinstance(result, str) else _summarize(result)
            activity.append({"tool": tool, "target": target[:80], "result": summary})

    def rec(tool: str, **kw: Any) -> None:
        audit.record(conn, "session_tool",
                     {"tool": tool, **{k: str(v)[:200] for k, v in kw.items()}}, run_id=None)

    @function_tool
    def list_providers() -> str:
        """List configured cloud storage providers (provider_id, name, type, endpoint, region, mode). Returns no secrets. Call this first to learn which provider_id values are available."""
        rec("list_providers")
        out = [{"provider_id": p.id, "name": p.name, "type": p.provider_type,
                "endpoint": p.endpoint_url, "region": p.region, "mode": p.mode,
                "allowed_buckets": p.allowed_buckets}
               for p in cloud_repo.list_all(conn)]
        note("list_providers", "", f"{len(out)} provider(s)")
        return json.dumps({"providers": out})

    @function_tool
    def list_buckets(provider_id: str) -> str:
        """List every bucket the provider's credentials can see (read-only ListBuckets). Args: provider_id."""
        if provider(provider_id) is None:
            return _err("Unknown provider_id. Call list_providers first.")
        rec("list_buckets", provider_id=provider_id)
        res = s3.list_buckets(conn, provider_id)
        note("list_buckets", provider_name(provider_id), res)
        return json.dumps(res)

    @function_tool
    def head_bucket(provider_id: str, bucket: str) -> str:
        """Check that a bucket exists and is reachable (read-only HeadBucket). Args: provider_id, bucket."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        if not bucket_ok(p, bucket):
            return _err("That bucket is not in this provider's allow-list.")
        rec("head_bucket", provider_id=provider_id, bucket=bucket)
        res = s3.head_bucket(conn, provider_id, bucket)
        note("head_bucket", bucket, res)
        return json.dumps(res)

    @function_tool
    def list_objects(provider_id: str, bucket: str, prefix: str = "", max_keys: int = 50) -> str:
        """List a bounded sample of object keys (read-only ListObjectsV2, max 100 keys; no object bodies). Args: provider_id, bucket, prefix?, max_keys?."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        if not bucket_ok(p, bucket):
            return _err("That bucket is not in this provider's allow-list.")
        bound = guardrails.bound_tool_args("list_objects_v2", {"max_keys": max_keys})
        rec("list_objects", provider_id=provider_id, bucket=bucket, prefix=prefix, max_keys=bound["max_keys"])
        res = s3.list_objects_v2(conn, provider_id, bucket, bound["max_keys"], prefix or None)
        note("list_objects", bucket, res)
        return json.dumps(res)

    tools = [list_providers, list_buckets, head_bucket, list_objects]

    # Per-bucket config reviews (read-only). Distinct names/descriptions set on
    # the FunctionTool after decoration (same pattern as the run agent).
    config_tools: list[tuple[str, Callable, str]] = [
        ("get_bucket_config_summary", ct.get_bucket_config_summary,
         "Summarize a bucket's readable configuration (encryption, versioning, policy, CORS, lifecycle, logging…). Args: provider_id, bucket."),
        ("review_bucket_security", ct.review_bucket_security,
         "Review a bucket's security posture (policy, ACL, public-access, encryption, CORS). Args: provider_id, bucket."),
        ("review_bucket_lifecycle", ct.review_bucket_lifecycle,
         "Review a bucket's lifecycle rules and version cleanup. Args: provider_id, bucket."),
        ("review_bucket_observability", ct.review_bucket_observability,
         "Review a bucket's logging, notifications, and tagging. Args: provider_id, bucket."),
        ("review_bucket_cost_optimization", ct.review_bucket_cost_optimization,
         "Review a bucket for cost-optimization opportunities. Args: provider_id, bucket."),
    ]

    def make_cfg(fn: Callable):
        @function_tool
        def _t(provider_id: str, bucket: str) -> str:
            p = provider(provider_id)
            if p is None:
                return _err("Unknown provider_id. Call list_providers first.")
            if not bucket_ok(p, bucket):
                return _err("That bucket is not in this provider's allow-list.")
            tname = getattr(_t, "name", "bucket_config")
            rec(tname, provider_id=provider_id, bucket=bucket)
            res = fn(conn, provider_id, bucket)
            note(tname, bucket, "reviewed" if not (isinstance(res, dict) and res.get("error")) else "error")
            return json.dumps(res)
        return _t

    for name, fn, desc in config_tools:
        t = make_cfg(fn)
        t.name = name  # type: ignore[attr-defined]
        t.__doc__ = desc
        tools.append(t)

    return tools
