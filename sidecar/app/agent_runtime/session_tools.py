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
from ..s3.scope import check_scope
from ..security.redaction import redact_text
from . import guardrails

# Max object keys echoed to the model per list_objects call. The bucket may hold
# far more; the agent pages via next_token for the rest. 500 (was 200): the S3
# layer already caps a page at 1000, and a fuller echo lets an enumeration finish
# in fewer turns; keys_truncated_in_context still tells the agent when the echo
# was cut (never a silent cap).
_LIST_KEYS_CTX_CAP = 500


def _err(msg: str) -> str:
    return json.dumps({"error": msg})


def _summarize(result: Any) -> str:
    if isinstance(result, dict):
        if result.get("error"):
            return str(result["error"])[:60]
        for key in ("buckets", "objects", "keys", "contents"):
            if isinstance(result.get(key), list):
                return f"{len(result[key])} {key}"
        if result.get("recommendation"):  # addressing-style probe
            return str(result["recommendation"])
        if result.get("tls_version"):  # TLS inspection
            return str(result["tls_version"])
        if "success" in result:
            return "ok" if result.get("success") else (result.get("error_code") or "failed")
        if result.get("error_code"):
            return str(result["error_code"])
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

    def scope_denial(p, bucket: str, *, key: str | None = None,
                     prefix: str | None = None, listing: bool = False) -> str | None:
        """Enforce BOTH allowed_buckets and allowed_prefixes on the agent surface.

        Previously the agent tools checked allowed_buckets only, so a
        prefix-scoped provider (allowed_prefixes=["logs/"]) gave the agent zero
        protection — it could preview_object/head_object/list outside the prefix.
        The agent is the only surface that reads object CONTENT, so it must honor
        the same scope as the /tools endpoints and run executors (check_scope).
        """
        return check_scope(p.allowed_buckets, p.allowed_prefixes, bucket,
                           key=key, prefix=prefix, listing=listing)

    # Per-turn budget: cap how many skill bodies the agent can load in one turn,
    # so a runaway loop can't pull every skill (~8000 chars each) into context.
    # 10 (was 8/6): a cross-domain investigation legitimately spans several skills;
    # keep the cap above what a real diagnosis needs, below "load everything".
    skill_loads = {"n": 0}
    _MAX_SKILL_LOADS = 10

    # Per-turn object-preview budget: preview_object reads bounded object CONTENT
    # (unlike the metadata-only probes), so bound it in code — a handful of small
    # objects per turn — so it can't be looped into a bulk download. This is the
    # agent-native equivalent of a gate: fluid within a code-enforced budget.
    # 16 calls / 24 MiB (was 12/16, 8/8): deep forensics comparing objects across
    # prefixes in one deep turn needs more looks; still far below anything
    # bulk-shaped (the 1 MiB/call cap and no-recursion rule keep it a probe).
    preview_budget = {"n": 0, "bytes": 0}
    _MAX_PREVIEWS = 16
    _MAX_PREVIEW_BYTES = 24 * 1024 * 1024

    # Per-turn latency-probe budget: measure_request_latency fires several live
    # round-trips per call, so cap how many probe RUNS a turn can do — the tool's
    # own per-call sample cap plus this keeps it a diagnostic probe, not a load
    # test. Bounds, not a gate. 8 (was 6): enough to compare a few endpoints/
    # addressing styles in one turn.
    latency_budget = {"n": 0}
    _MAX_LATENCY_RUNS = 8

    # Per-turn ranged-read budget: test_range_get is the one download-shaped
    # probe (it reads real object bytes, capped per call in the S3 layer), so
    # bound how many ranged reads a turn can fire — a probe, not a downloader.
    range_budget = {"n": 0}
    _MAX_RANGE_GETS = 12

    def note(tool: str, target: str, result: Any) -> None:
        if activity is not None:
            summary = result if isinstance(result, str) else _summarize(result)
            activity.append({"tool": tool, "target": target[:80], "result": summary,
                             "status": "completed"})

    def _target_of(kw: dict[str, Any]) -> str:
        bucket, key = kw.get("bucket"), kw.get("key")
        if bucket and key:
            return f"{bucket}/{key}"
        return str(bucket or kw.get("name") or kw.get("provider_id") or kw.get("endpoint") or "")

    def rec(tool: str, **kw: Any) -> None:
        # Commit the audit row immediately. audit.record() deliberately doesn't
        # commit (run executors batch on it), but here the audit row is the only
        # write on the request connection during a turn. Leaving it uncommitted
        # makes the connection hold the SQLite/WAL write lock across the next
        # slow S3 tool call, which can starve a concurrently-running inline run's
        # writes for >busy_timeout → "database is locked". Keep the write txn tiny.
        audit.record(conn, "session_tool",
                     {"tool": tool, **{k: str(v)[:200] for k, v in kw.items()}}, run_id=None)
        conn.commit()
        # Emit a START record so the live stream can show "running <tool>…"
        # while the (possibly slow) call executes. Only "completed" records are
        # persisted on the message; the UI ignores fields it doesn't know.
        if activity is not None:
            activity.append({"tool": tool, "target": _target_of(kw)[:80], "status": "started"})

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
        denial = scope_denial(p, bucket)
        if denial:
            return _err(denial)
        rec("head_bucket", provider_id=provider_id, bucket=bucket)
        res = s3.head_bucket(conn, provider_id, bucket)
        note("head_bucket", bucket, res)
        return json.dumps(res)

    @function_tool
    def list_objects(provider_id: str, bucket: str, prefix: str = "", max_keys: int = 200,
                     continuation_token: str = "", recursive: bool = False) -> str:
        """List one page of object keys (read-only ListObjectsV2, up to 1000 per call; no object bodies). To enumerate fully, PAGE: re-call with continuation_token = the previous result's next_token until next_token is null, accumulating result.keys. Set recursive=true to list keys flat under the prefix (no '/' directory grouping). Args: provider_id, bucket, prefix?, max_keys? (up to 1000), continuation_token?, recursive?."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, prefix=prefix or None, listing=True)
        if denial:
            return _err(denial)
        bound = guardrails.bound_tool_args("list_objects_v2", {"max_keys": max_keys})
        rec("list_objects", provider_id=provider_id, bucket=bucket, prefix=prefix,
            max_keys=bound["max_keys"], paged=bool(continuation_token))
        res = s3.list_objects_v2(conn, provider_id, bucket, bound["max_keys"], prefix or None,
                                 continuation_token=continuation_token or None,
                                 delimiter=None if recursive else "/")
        # Cap the keys handed to the model per call so a paged enumeration can't
        # flood the context; key_count stays accurate and next_token lets the
        # agent keep paging.
        if isinstance(res, dict) and isinstance(res.get("keys"), list) and len(res["keys"]) > _LIST_KEYS_CTX_CAP:
            res["keys"] = res["keys"][:_LIST_KEYS_CTX_CAP]
            res["keys_truncated_in_context"] = True
        note("list_objects", bucket, res)
        return json.dumps(res)

    @function_tool
    def list_object_versions(provider_id: str, bucket: str, prefix: str = "", max_keys: int = 1000) -> str:
        """List one page of object VERSIONS + delete markers (read-only ListObjectVersions; no bodies). Surfaces the actual noncurrent-version / delete-marker pileup a versioned bucket carries — which config review can't see (it only shows whether versioning + a cleanup rule exist). Use for "why is my versioned bucket so large/expensive?". Returns version/noncurrent/delete-marker counts, current vs noncurrent bytes, ≤20 sample keys, and paging markers. Args: provider_id, bucket, prefix?, max_keys? (up to 1000)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, prefix=prefix or None, listing=True)
        if denial:
            return _err(denial)
        bound = guardrails.bound_tool_args("list_objects_v2", {"max_keys": max_keys})
        rec("list_object_versions", provider_id=provider_id, bucket=bucket, prefix=prefix, max_keys=bound["max_keys"])
        res = s3.list_object_versions(conn, provider_id, bucket, prefix or None, bound["max_keys"])
        note("list_object_versions", bucket, res)
        return json.dumps(res)

    @function_tool
    def list_multipart_uploads(provider_id: str, bucket: str, max_uploads: int = 1000) -> str:
        """List one page of in-progress / incomplete multipart uploads (read-only ListMultipartUploads; no bodies). Surfaces abandoned uploads — a common silent cost leak (parts are billed but invisible in a normal object listing). Use for unexplained storage/cost. Returns upload count, oldest initiation time, ≤20 sample keys, and paging markers. Listing only — aborting is a mutation and is not available; propose a lifecycle rule instead. Args: provider_id, bucket, max_uploads? (up to 1000)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, listing=True)
        if denial:
            return _err(denial)
        bound = guardrails.bound_tool_args("list_objects_v2", {"max_keys": max_uploads})
        rec("list_multipart_uploads", provider_id=provider_id, bucket=bucket, max_uploads=bound["max_keys"])
        res = s3.list_multipart_uploads(conn, provider_id, bucket, bound["max_keys"])
        note("list_multipart_uploads", bucket, res)
        return json.dumps(res)

    @function_tool
    def test_credentials(provider_id: str) -> str:
        """Validate the provider's credentials with a read-only call — the first step for any auth/403/SignatureDoesNotMatch diagnosis. Returns whether the keys work and the identity/endpoint reached (no secrets). Args: provider_id."""
        if provider(provider_id) is None:
            return _err("Unknown provider_id. Call list_providers first.")
        rec("test_credentials", provider_id=provider_id)
        res = s3.test_credentials(conn, provider_id)
        note("test_credentials", provider_name(provider_id), res)
        return json.dumps(res)

    @function_tool
    def head_object(provider_id: str, bucket: str, key: str) -> str:
        """Read one object's metadata — size, ETag, last-modified, storage class, sanitized user metadata (read-only HeadObject; no body). Use to confirm an object exists, check its storage class, or diagnose a 403/404 on a specific key. Args: provider_id, bucket, key."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        rec("head_object", provider_id=provider_id, bucket=bucket, key=key)
        res = s3.head_object(conn, provider_id, bucket, key)
        note("head_object", f"{bucket}/{key}", res)
        return json.dumps(res)

    @function_tool
    def get_object_lock_status(provider_id: str, bucket: str, key: str, version_id: str = "") -> str:
        """Read ONE object's Object-Lock state — retention mode + retain-until date and legal-hold status (read-only GetObjectRetention + GetObjectLegalHold; no body). Use for "why can't I delete/overwrite this object?" — bucket-level config review shows only whether object-lock is enabled, not a specific object's lock. A missing lock (or a provider that doesn't implement object-lock) is reported as a normal 'none'/'provider_unsupported' state, not an error. Args: provider_id, bucket, key, version_id? (a specific version)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        rec("get_object_lock_status", provider_id=provider_id, bucket=bucket, key=key)
        res = s3.get_object_lock_status(conn, provider_id, bucket, key, version_id or None)
        note("get_object_lock_status", f"{bucket}/{key}", res)
        return json.dumps(res)

    @function_tool
    def test_range_get(provider_id: str, bucket: str, key: str, range_header: str = "bytes=0-1023") -> str:
        """Test a bounded ranged read of one object (read-only GET with a Range header; reads at most the requested bytes). Use to verify range-GET support, partial-read latency, or CDN/range behavior. Args: provider_id, bucket, key, range_header? (default bytes=0-1023)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        if range_budget["n"] >= _MAX_RANGE_GETS:
            return _err(f"Ranged-read budget for this turn is used up ({_MAX_RANGE_GETS} calls). "
                        "Report the range behavior you already measured, or ask the user "
                        "which object matters most.")
        rec("test_range_get", provider_id=provider_id, bucket=bucket, key=key, range_header=range_header)
        res = s3.test_range_get(conn, provider_id, bucket, key, range_header)
        range_budget["n"] += 1
        note("test_range_get", f"{bucket}/{key}", res)
        return json.dumps(res)

    @function_tool
    def preview_object(provider_id: str, bucket: str, key: str, max_bytes: int = 262144) -> str:
        """Read a BOUNDED, read-only, sanitized preview of ONE object's content (its first bytes, capped at 1 MiB). Use when the user asks what is INSIDE an object — a manifest, a small config/JSON/YAML, or a sample of a log/data object. Gzip objects (.gz) are decompressed within the same bound ("decompressed": true); .parquet objects return a STRUCTURE preview (schema, row counts — footer only, never the body). Other binary or oversized objects are reported, not decoded; secrets are redacted. Bounded per turn (a few objects); NOT a way to bulk-download. For metadata only, use head_object instead. Args: provider_id, bucket, key, max_bytes? (default 256 KiB, capped at 1 MiB)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        if preview_budget["n"] >= _MAX_PREVIEWS or preview_budget["bytes"] >= _MAX_PREVIEW_BYTES:
            return _err(
                f"Object-preview budget for this turn is used up ({_MAX_PREVIEWS} objects / "
                f"{_MAX_PREVIEW_BYTES // (1024 * 1024)} MiB). Summarize what you found, or ask the "
                "user which object matters most."
            )
        rec("preview_object", provider_id=provider_id, bucket=bucket, key=key)
        res = s3.preview_object(conn, provider_id, bucket, key, max_bytes)
        preview_budget["n"] += 1
        preview_budget["bytes"] += int(res.get("bytes_read") or 0)
        if res.get("parquet"):
            trace = f"parquet schema ({len(res['parquet'].get('columns', []))} cols)"
        elif res.get("binary"):
            trace = "binary"
        elif res.get("decompressed"):
            trace = f"{res.get('bytes_read', 0)} bytes (gzip)"
        else:
            trace = f"{res.get('bytes_read', 0)} bytes"
        note("preview_object", f"{bucket}/{key}", trace)
        return json.dumps(res)

    @function_tool
    def test_addressing_style(provider_id: str, bucket: str) -> str:
        """Probe virtual-hosted vs. path-style addressing (two read-only HeadBucket calls) and recommend which works. Key for SignatureDoesNotMatch / endpoint / 'bucket not found on S3-compatible provider' diagnosis. Args: provider_id, bucket."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket)
        if denial:
            return _err(denial)
        rec("test_addressing_style", provider_id=provider_id, bucket=bucket)
        res = s3.test_path_style_vs_virtual_host(conn, provider_id, bucket)
        note("test_addressing_style", bucket, res)
        return json.dumps(res)

    @function_tool
    def measure_request_latency(provider_id: str, bucket: str, key: str = "", samples: int = 5) -> str:
        """Measure LIVE request latency to the endpoint — the only tool that turns "it's slow" into numbers. Fires a BOUNDED number of lightweight round-trips (HeadBucket, or HeadObject if key is given; no object bodies) and returns min/p50/p95/max/mean milliseconds. Use for performance complaints (high TTFB, slow ops, cross-region latency) before reasoning about causes. Bounded per turn — a diagnostic probe, not a load test. Args: provider_id, bucket, key? (probe a specific object), samples? (default 5, max 10)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key or None)
        if denial:
            return _err(denial)
        if latency_budget["n"] >= _MAX_LATENCY_RUNS:
            return _err(f"Latency-probe budget for this turn is used up ({_MAX_LATENCY_RUNS} runs). "
                        "Report the measurements you have, or ask the user which target matters most.")
        rec("measure_request_latency", provider_id=provider_id, bucket=bucket, key=key, samples=samples)
        res = s3.measure_request_latency(conn, provider_id, bucket, key or None, samples)
        latency_budget["n"] += 1
        note("measure_request_latency", f"{bucket}/{key}" if key else bucket,
             f"p50 {res.get('p50_ms')}ms" if res.get("success") else "error")
        return json.dumps(res)

    @function_tool
    def read_skill(name: str) -> str:
        """Load the full method of a StorageOps expert skill by name (progressive disclosure). Pick a name from the StorageOps skills catalog in your context; this returns that skill's diagnostic method as guidance text for you to apply with your read-only tools. Args: name (e.g. 'storageops-security-iam-policy')."""
        from ..skills import context as skill_context
        if skill_loads["n"] >= _MAX_SKILL_LOADS:
            return _err(f"Skill-load budget reached ({_MAX_SKILL_LOADS} per turn). "
                        "Apply the skills you've already loaded, or proceed with your read-only tools.")
        body = skill_context.read_skill_text(name)
        if body is None:
            return _err("Unknown skill name. Use a name from the StorageOps skills catalog.")
        skill_loads["n"] += 1
        rec("read_skill", name=name)
        note("read_skill", name, "loaded")
        return body

    @function_tool
    def inspect_endpoint_tls(provider_id: str) -> str:
        """Inspect the provider endpoint's TLS certificate (version, subject, issuer, validity) over a read-only connection. Use for TLS/SSL handshake, expired-cert, or hostname-mismatch errors. Args: provider_id."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        endpoint = p.endpoint_url
        if not endpoint and p.region:
            endpoint = f"https://s3.{p.region}.amazonaws.com"
        if not endpoint:
            return _err("This provider has no endpoint URL configured; TLS inspection needs one.")
        rec("inspect_endpoint_tls", provider_id=provider_id, endpoint=endpoint)
        res = s3.inspect_tls(endpoint)
        note("inspect_endpoint_tls", provider_name(provider_id), res)
        return json.dumps(res)

    @function_tool
    def get_bucket_config_detail(provider_id: str, bucket: str, aspect: str) -> str:
        """Read the SANITIZED RULE DETAIL of one bucket-config aspect (read-only GET). The config review tools return only a status/boolean for these; this returns the actual rules a diagnosis needs — so you don't have to ask the user for the config. `aspect` is one of: 'replication' (per-rule status, prefix/tag filter, delete-marker replication, destination bucket), 'notification' (per-target type topic/queue/lambda/eventbridge + resource name, events, prefix/suffix filter — use for "my event/Lambda isn't firing"), 'cors' (allowed origins/methods/headers — use for browser CORS failures), 'logging' (the access-log target bucket/prefix). ARNs are reduced (no account IDs), values redacted, ≤20 rules. A provider lacking the API returns status='provider_unsupported', not an error. Args: provider_id, bucket, aspect."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket)
        if denial:
            return _err(denial)
        rec("get_bucket_config_detail", provider_id=provider_id, bucket=bucket, aspect=aspect)
        try:
            res = ct.get_bucket_config_detail(conn, provider_id, bucket, aspect)
        except Exception as exc:  # noqa: BLE001 — a tool returns an error string, never raises
            return _err(redact_text(f"get_bucket_config_detail failed: {exc}"))
        note("get_bucket_config_detail", f"{bucket} · {aspect}",
             res.get("status") if res.get("success") else "error")
        return json.dumps(res)

    tools = [list_providers, list_buckets, head_bucket, list_objects,
             list_object_versions, list_multipart_uploads,
             test_credentials, head_object, get_object_lock_status,
             test_range_get, preview_object, measure_request_latency,
             test_addressing_style, inspect_endpoint_tls,
             get_bucket_config_detail, read_skill]

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
        ("review_bucket_performance_profile", ct.review_bucket_performance_profile,
         "Profile a bucket's performance from a bounded object sample (key layout, sizes, storage classes). Args: provider_id, bucket."),
    ]

    def make_cfg(fn: Callable):
        @function_tool
        def _t(provider_id: str, bucket: str) -> str:
            p = provider(provider_id)
            if p is None:
                return _err("Unknown provider_id. Call list_providers first.")
            denial = scope_denial(p, bucket)
            if denial:
                return _err(denial)
            tname = getattr(_t, "name", "bucket_config")
            rec(tname, provider_id=provider_id, bucket=bucket)
            try:
                res = fn(conn, provider_id, bucket)
            except Exception as exc:  # noqa: BLE001 — a tool returns an error string, never raises
                return _err(redact_text(f"{tname} failed: {exc}"))
            note(tname, bucket, "reviewed" if not (isinstance(res, dict) and res.get("error")) else "error")
            return json.dumps(res)
        return _t

    for name, fn, desc in config_tools:
        t = make_cfg(fn)
        # `function_tool` freezes name/description/schema from the decorated
        # inner `_t` at decoration time. Assigning `__doc__` afterwards is a
        # no-op on the already-built FunctionTool — the model would see a blank
        # description and a schema titled "_t", so it would pick these six tools
        # on name alone. Set the FunctionTool fields directly instead.
        t.name = name  # type: ignore[attr-defined]
        t.description = desc  # type: ignore[attr-defined]
        params = getattr(t, "params_json_schema", None)
        if isinstance(params, dict) and params.get("title") == "_t":
            params["title"] = name
        tools.append(t)

    return tools
