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
import re
import sqlite3
import threading
import time
import uuid
from typing import Any, Callable

from .. import audit, db
from ..repositories import cloud_providers as cloud_repo
from ..repositories import utcnow
from ..s3 import config_tools as ct
from ..s3 import tools as s3
from ..s3.scope import check_scope
from ..security.redaction import redact, redact_text
from . import guardrails

# Max object keys echoed to the model per list_objects call — equal to the S3
# layer's page cap (MAX_LIST_KEYS = 1000), and it MUST stay >= that cap: the S3
# layer computes next_token over the FULL page, so an echo cap below the page
# size would drop the tail keys with no way to page back to them (paging with
# next_token skips straight past the whole page) — silently incomplete
# enumeration. A full 1000-key page is ~50 KB, comfortably inside the elastic
# tool-output budget, which still backstops pathological key lengths.
_LIST_KEYS_CTX_CAP = s3.MAX_LIST_KEYS


def _compact_list_page(res: Any) -> Any:
    """Strip the list page's redundant copies of the SAME key strings.

    ``list_objects_v2`` returns each page's keys three times over: ``sample_keys``
    (the first 20), ``keys`` (the whole page), and ``objects`` (the first 100,
    each entry repeating its key alongside size/storage-class/mtime). On a
    1000-key page that is ~6 KB of characters carrying no information the model
    does not already have on the line above — and it is re-sent on every later
    step of the turn.

    Two exact removals, both verified before they are applied:

    - ``sample_keys`` goes when it is a genuine prefix of ``keys`` (it always is;
      it survives in the S3 layer for the run executors that still read it).
    - each ``objects[i]["key"]`` goes when it equals ``keys[i]`` for EVERY entry,
      and the payload then says so explicitly with ``objects_align_with_keys``,
      which the tool docstring also teaches.

    If either shape does not hold — a provider returning something unexpected,
    a future change to the S3 layer — nothing is removed. Mutates and returns
    the same dict."""
    if not isinstance(res, dict):
        return res
    keys = res.get("keys")
    if not isinstance(keys, list):
        return res
    sample = res.get("sample_keys")
    if isinstance(sample, list) and keys[:len(sample)] == sample:
        res.pop("sample_keys", None)
    objects = res.get("objects")
    if (isinstance(objects, list) and objects and len(objects) <= len(keys)
            and all(isinstance(o, dict) and o.get("key") == keys[i]
                    for i, o in enumerate(objects))):
        res["objects"] = [{k: v for k, v in o.items() if k != "key"} for o in objects]
        res["objects_align_with_keys"] = True
    return res


def _unlock_groups_for_skill(body: str, unlocked: set[str] | None) -> list[str]:
    """Open the gated groups whose tools this skill's method actually names.

    Derived from the skill TEXT rather than a hand-kept table, so a skill edited
    to use a different tool cannot drift out of sync with what it can reach.
    Word-boundary matched, so a tool name inside a longer identifier does not
    count. Returns the groups newly opened (empty when there is nothing to do)."""
    if unlocked is None:
        return []
    from .session_agent import _GROUP_OF_TOOL
    opened: list[str] = []
    for tool_name, group in _GROUP_OF_TOOL.items():
        if group in unlocked:
            continue
        if re.search(rf"\b{re.escape(tool_name)}\b", body):
            unlocked.add(group)
            opened.append(group)
    return sorted(opened)


def _err(msg: str) -> str:
    return json.dumps({"error": msg})


def _out(res: Any) -> str:
    """A tool result, as compactly as JSON allows.

    Every tool result stays in the conversation for the rest of the turn and is
    re-sent on each later step, so the default `", "` / `": "` separators are
    paid many times over. Measured on one full list_objects page: 75,603 chars
    against 73,794 compact. Small per call, not per turn — and free."""
    return json.dumps(res, separators=(",", ":"), default=str, ensure_ascii=False)


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
            if result.get("success"):
                return "ok"
            return _failure_line(result)
        if result.get("error_code"):
            return _failure_line(result)
    return "done"


def _failure_line(result: dict[str, Any]) -> str:
    """A failure the reader can act on: the code, plus the request id.

    The id is what a provider's support desk asks for first, and an unexplained
    500/503 from an S3-compatible gateway is otherwise a dead end. It is short,
    opaque and carries no secret — it identifies the request, not the caller."""
    code = str(result.get("error_code") or "failed")
    rid = result.get("request_id")
    return f"{code} · req {str(rid)[:24]}" if rid else code


def build(conn: sqlite3.Connection, function_tool: Callable,
          activity: list[dict[str, Any]] | None = None,
          session_id: str | None = None,
          unlocked: set[str] | None = None) -> list[Any]:
    """Build the read-only investigator tool set bound to this DB connection.

    If ``activity`` is given, each tool call appends a sanitized record
    {tool, target, result} for the UI to show ("ran list_buckets → 96 buckets").

    ``session_id`` makes the turn's work retrievable afterwards: the rec/note
    pair below writes a real ``tool_calls`` row (sanitized input + output +
    measured duration) and stamps the audit row, so a session's activity can be
    inspected later instead of surviving only as the one-line thread trace.

    ``unlocked`` is the turn's progressive-disclosure state (v0.55.0). Only
    ``read_skill`` touches it: a skill's method names the tools it is carried out
    with, so LOADING the skill is the statement of intent that opening those
    groups would otherwise cost a separate round-trip to express.
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

    # Per-turn budget: a runaway-loop guard on skill-body loads, NOT the real
    # context bound — read_skill output is NOT budget-exempt, so each ~8000-char
    # skill body already counts against the model-elastic tool-output budget
    # (200k floor → up to 1M on a large-context model). So this stays a fixed
    # guard, raised to 20 (was 10) so a legitimately cross-domain investigation on
    # a large model isn't clipped below what the elastic byte budget would allow.
    skill_loads = {"n": 0}
    _MAX_SKILL_LOADS = 20

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
        summary = result if isinstance(result, str) else _summarize(result)
        _open = _open_slot()
        matched = _open.get("tool") == tool
        started = _open.get("t0") if matched else None
        call_input = _open.get("input") if matched else {}
        # The id `rec` minted for THIS call. It is the row's primary key, the
        # live row's identity, and the link between the two (v0.55.0).
        call_id = str(_open.get("call_id") or uuid.uuid4().hex) if matched else uuid.uuid4().hex
        duration_ms = int((time.monotonic() - started) * 1000) if started else None
        # Whether the call SUCCEEDED, computed exactly — the same expression the
        # persisted row has always used. The thread used to infer it from the
        # result text with /^(error|failed)\b/, which matched none of the real
        # failure shapes this product produces (`AccessDenied · req 8A9F2C1B`,
        # `NoSuchBucket`, `SignatureDoesNotMatch`), so failed calls rendered
        # green and the "N failed" badge under-counted.
        ok = not (isinstance(result, dict) and result.get("success") is False)
        if activity is not None:
            # Carry the args forward from the matching `started` record so the
            # finished row reads the same as the live one. Only when the open
            # call IS this tool — stale args would misdescribe the call.
            args = dict(_open.get("args") or {}) if matched else {}
            activity.append({"id": call_id, "tool": tool, "target": target[:80],
                             "result": summary, "args": args, "ok": ok,
                             "duration_ms": duration_ms, "status": "completed"})
        _open.clear()
        if session_id is None:
            return
        # Persist the call itself, not just the thread trace: sanitized input +
        # output + the REAL elapsed time (nothing measured this before, so
        # "which step was slow" was unanswerable). Best-effort — a bookkeeping
        # failure must never break the tool the user actually asked for.
        try:
            with db.WRITE_LOCK:
                conn.execute(
                    "INSERT INTO tool_calls (id, run_id, session_id, tool_name, "
                    " input_json_sanitized, output_json_sanitized, status, duration_ms, created_at) "
                    "VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)",
                    # Same id as the live row: the thread can now open a call's real
                    # persisted input/output instead of guessing by time window.
                    (call_id, session_id, tool,
                     json.dumps(redact({"target": target[:200], **(call_input or {})})),
                     json.dumps(redact({"summary": summary})),
                     "success" if ok else "error", duration_ms, utcnow()),
                )
                conn.commit()
        except Exception:  # noqa: BLE001 - observability must never break a turn
            pass

    def _target_of(kw: dict[str, Any]) -> str:
        bucket, key = kw.get("bucket"), kw.get("key")
        if bucket and key:
            return f"{bucket}/{key}"
        return str(bucket or kw.get("name") or kw.get("provider_id") or kw.get("endpoint") or "")

    # Arguments that change what a call MEANS, and are worth the width in a live
    # trace row. `target` already carries bucket/key; provider_id is an opaque id
    # a reader cannot use. Everything else is bounded and redacted like the rest.
    _ARG_KEYS = ("prefix", "aspect", "max_keys", "max_uploads", "max_parts", "max_bytes",
                 "recursive", "paged", "version_id", "upload_id", "etag", "range_bytes",
                 "samples")

    def _args_of(kw: dict[str, Any]) -> dict[str, Any]:
        """The call's distinguishing arguments, for the LIVE trace.

        `list_objects(prefix="logs/2026/08/", max_keys=1000, recursive=True)`
        rendered as just the bucket name — three arguments that decide what the
        call means were invisible while it ran, even though `rec` has always
        written them to `tool_calls`. This is the same data reaching the stream."""
        out: dict[str, Any] = {}
        for k in _ARG_KEYS:
            v = kw.get(k)
            if v is None or v == "" or v is False:
                continue
            out[k] = redact_text(str(v))[:80] if isinstance(v, str) else v
        return out

    # The open call being timed by rec(), closed by the matching note() —
    # PER THREAD (v0.55.0).
    #
    # This was a single shared dict, on the stated assumption that "only ever one
    # [is] in flight — the agent runs tools sequentially within a turn". v0.54.0
    # turned on parallel tool calls and the Agents SDK dispatches a sync tool with
    # ``asyncio.to_thread``, so two tool bodies now genuinely run at once. Sharing
    # one slot meant the second rec() cleared the first call's state and the
    # first note() then found nothing: no args, no duration, and a persisted
    # input of ``{}``.
    #
    # Keying by thread id is exact for every case the SDK produces. Concurrent
    # calls are in different threads, so they cannot see each other's slot; calls
    # in one thread cannot interleave, because a sync body has no await point
    # between its rec() and its note().
    _open_by_thread: dict[int, dict[str, Any]] = {}

    def _open_slot() -> dict[str, Any]:
        return _open_by_thread.setdefault(threading.get_ident(), {})

    def rec(tool: str, **kw: Any) -> None:
        # Commit the audit row immediately. audit.record() deliberately doesn't
        # commit (run executors batch on it), but here the audit row is the only
        # write on the request connection during a turn. Leaving it uncommitted
        # makes the connection hold the SQLite/WAL write lock across the next
        # slow S3 tool call, which can starve a concurrently-running inline run's
        # writes for >busy_timeout → "database is locked". Keep the write txn tiny.
        # Under db.WRITE_LOCK: with parallel tool calls two bodies share this
        # ONE connection, so an unguarded commit here can commit the other call's
        # half-written work and then raise on its own commit (v0.55.0).
        with db.WRITE_LOCK:
            audit.record(conn, "session_tool",
                         {"tool": tool, **{k: str(v)[:200] for k, v in kw.items()}},
                         run_id=None, session_id=session_id)
            conn.commit()
        # One id per call, minted here and carried to both the live row and the
        # persisted tool_calls row (v0.55.0). Matching a completed record to its
        # started row by (tool, target) broke the moment v0.54.0 turned on
        # parallel tool calls: two concurrent get_bucket_config_detail calls on
        # ONE bucket differ only by `aspect`, so the merge could resolve the
        # wrong row and mislabel both. An id cannot be ambiguous.
        call_id = uuid.uuid4().hex
        _open = _open_slot()
        _open.clear()
        _open.update({"tool": tool, "input": {k: str(v)[:200] for k, v in kw.items()},
                      "args": _args_of(kw), "t0": time.monotonic(), "call_id": call_id})
        # Emit a START record so the live stream can show "running <tool>…"
        # while the (possibly slow) call executes. Only "completed" records are
        # persisted on the message; the UI ignores fields it doesn't know.
        if activity is not None:
            activity.append({"id": call_id, "tool": tool, "target": _target_of(kw)[:80],
                             "args": _args_of(kw), "status": "started"})

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
        return _out(res)

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
        return _out(res)

    @function_tool
    def get_bucket_location(provider_id: str, bucket: str) -> str:
        """Where does this bucket actually live? ONE read-only GetBucketLocation. Use this FIRST for any endpoint/region symptom — a 301 PermanentRedirect, an AuthorizationHeaderMalformed naming a region, a SignatureDoesNotMatch that only happens on one bucket, or a bucket that 404s from one endpoint but exists. Returns bucket_region, the configured_region/endpoint_url for comparison, and region_mismatch (null when either side is unknown — an unset region on a custom endpoint is normal). Answers a redirect too: the bucket's real region comes back even when the configured endpoint cannot serve it. `provider_unsupported` on a gateway without the API. Args: provider_id, bucket."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket)
        if denial:
            return _err(denial)
        rec("get_bucket_location", provider_id=provider_id, bucket=bucket)
        res = s3.get_bucket_location(conn, provider_id, bucket)
        note("get_bucket_location", bucket, res)
        return _out(res)

    @function_tool
    def list_objects(provider_id: str, bucket: str, prefix: str = "", max_keys: int = 200,
                     continuation_token: str = "", recursive: bool = False) -> str:
        """List one page of object keys (read-only ListObjectsV2, up to 1000/call; no bodies). To enumerate fully, PAGE: re-call with continuation_token = the previous next_token until it is null, accumulating result.keys — the FULL page is echoed in `keys`, and paging skips past it, so never treat one page's key_count as the bucket total. `objects` carries {size, storage_class, last_modified} for the first 100 keys POSITIONALLY (objects[i] describes keys[i], flagged by objects_align_with_keys) — sample size/storage-class distribution from it instead of N head_object calls. recursive=true lists flat (no '/' grouping). For a bucket far larger than paging can cover, propose an inventory analysis. Args: provider_id, bucket, prefix?, max_keys? (up to 1000), continuation_token?, recursive?."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, prefix=prefix or None, listing=True)
        if denial:
            return _err(denial)
        bound = guardrails.bound_tool_args("list_objects_v2", {"max_keys": max_keys})
        # `recursive` is translated to a delimiter below, so record it here or
        # the trace cannot distinguish a flat enumeration from a directory-style
        # one — the difference between "listed a folder" and "walked the bucket".
        rec("list_objects", provider_id=provider_id, bucket=bucket, prefix=prefix,
            max_keys=bound["max_keys"], recursive=bool(recursive),
            paged=bool(continuation_token))
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
        return _out(_compact_list_page(res))

    @function_tool
    def list_object_versions(provider_id: str, bucket: str, prefix: str = "", max_keys: int = 1000,
                             key_marker: str = "", version_id_marker: str = "") -> str:
        """List one page of object VERSIONS + delete markers (read-only; no bodies). Surfaces the noncurrent-version / delete-marker pileup that config review cannot see (it only shows whether versioning + a cleanup rule exist) — the answer to "why is my versioned bucket so large?". Returns version/noncurrent/delete-marker counts, current vs noncurrent bytes, ≤20 sample keys, and next_key_marker/next_version_id_marker. When is_truncated, the counts are ONE page, not the bucket total: page with those markers. Args: provider_id, bucket, prefix?, max_keys? (up to 1000), key_marker?, version_id_marker?."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, prefix=prefix or None, listing=True)
        if denial:
            return _err(denial)
        bound = guardrails.bound_tool_args("list_objects_v2", {"max_keys": max_keys})
        rec("list_object_versions", provider_id=provider_id, bucket=bucket, prefix=prefix, max_keys=bound["max_keys"])
        res = s3.list_object_versions(conn, provider_id, bucket, prefix or None, bound["max_keys"],
                                      key_marker=key_marker or None, version_id_marker=version_id_marker or None)
        note("list_object_versions", bucket, res)
        return _out(res)

    @function_tool
    def list_multipart_uploads(provider_id: str, bucket: str, prefix: str = "", max_uploads: int = 1000,
                               key_marker: str = "", upload_id_marker: str = "") -> str:
        """List one page of in-progress / incomplete multipart uploads (read-only; no bodies). Abandoned uploads are billed but invisible in a normal listing — a common silent cost leak. Returns upload count, oldest initiation time, ≤20 sample keys, and next_key_marker/next_upload_id_marker; when is_truncated the count is ONE page, not the total. Listing only — aborting is a mutation and does not exist here; propose an AbortIncompleteMultipartUpload lifecycle rule instead. Args: provider_id, bucket, prefix? (REQUIRED on a prefix-scoped provider), max_uploads? (up to 1000), key_marker?, upload_id_marker?."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, prefix=prefix or None, listing=True)
        if denial:
            return _err(denial)
        bound = guardrails.bound_tool_args("list_objects_v2", {"max_keys": max_uploads})
        rec("list_multipart_uploads", provider_id=provider_id, bucket=bucket,
            prefix=prefix or None, max_uploads=bound["max_keys"])
        res = s3.list_multipart_uploads(conn, provider_id, bucket, bound["max_keys"],
                                        prefix=prefix or None,
                                        key_marker=key_marker or None, upload_id_marker=upload_id_marker or None)
        note("list_multipart_uploads", bucket, res)
        return _out(res)

    @function_tool
    def test_credentials(provider_id: str) -> str:
        """Validate the provider's credentials with a read-only call — the first step for any auth/403/SignatureDoesNotMatch diagnosis. Returns whether the keys work and the identity/endpoint reached (no secrets). Args: provider_id."""
        if provider(provider_id) is None:
            return _err("Unknown provider_id. Call list_providers first.")
        rec("test_credentials", provider_id=provider_id)
        res = s3.test_credentials(conn, provider_id)
        note("test_credentials", provider_name(provider_id), res)
        return _out(res)

    @function_tool
    def head_object(provider_id: str, bucket: str, key: str, version_id: str = "") -> str:
        """Read one object's metadata (read-only HeadObject; no body): size, ETag, last-modified, storage class, sanitized user metadata — plus the diagnostic headers replication_status ("did this replicate?"), restore ("why isn't my Glacier restore ready?"), archive_status, parts_count, lifecycle_expiration ("when will lifecycle delete this?"), version_id, and content_type/content_encoding/cache_control for stale-read diagnosis. Use to confirm an object exists, check its state, or diagnose a 403/404 on a specific key. Args: provider_id, bucket, key, version_id? (HEAD a specific version — compare current vs noncurrent)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        rec("head_object", provider_id=provider_id, bucket=bucket, key=key)
        res = s3.head_object(conn, provider_id, bucket, key, version_id or None)
        note("head_object", f"{bucket}/{key}", res)
        return _out(res)

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
        return _out(res)

    @function_tool
    def get_object_acl(provider_id: str, bucket: str, key: str, version_id: str = "") -> str:
        """Read ONE object's ACL — who is granted what (read-only GetObjectAcl; no body). Use for "is THIS object public?" or "who can read this object?" — bucket-level security review shows only the bucket's posture, not a specific object's grants (an object can be public even under a locked-down bucket). Grantees are reduced to a KIND (public-all-users / authenticated-users / canonical-user / log-delivery / email-user) so no owner id, canonical id, or email leaks; a public grant (AllUsers/AuthenticatedUsers) sets is_public with the granted permissions. A provider without object-ACL support reports acl_status='provider_unsupported', not an error. Args: provider_id, bucket, key, version_id? (a specific version)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        rec("get_object_acl", provider_id=provider_id, bucket=bucket, key=key)
        res = s3.get_object_acl(conn, provider_id, bucket, key, version_id or None)
        note("get_object_acl", f"{bucket}/{key}", "public" if res.get("is_public") else res.get("acl_status", res))
        return _out(res)

    @function_tool
    def get_object_tagging(provider_id: str, bucket: str, key: str, version_id: str = "") -> str:
        """Read ONE object's tag set (read-only GetObjectTagging; no body). Object tags drive lifecycle rules, cost attribution, and tag-based access policies, so "what tags does this object carry?" is a real diagnostic (e.g. why a lifecycle/tag-scoped policy does or doesn't apply to it). Both tag keys and values are redacted defensively (they are user-controlled). Bounded to 20 tags. An untagged object is a normal empty result; a provider without object tagging reports tagging_status='provider_unsupported'. Args: provider_id, bucket, key, version_id?."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        rec("get_object_tagging", provider_id=provider_id, bucket=bucket, key=key)
        res = s3.get_object_tagging(conn, provider_id, bucket, key, version_id or None)
        note("get_object_tagging", f"{bucket}/{key}",
             f"{res.get('tag_count', 0)} tags" if res.get("success") else res)
        return _out(res)

    @function_tool
    def get_object_attributes(provider_id: str, bucket: str, key: str, version_id: str = "") -> str:
        """Read ONE object's attributes — checksum algorithm, multipart part count, storage class, size (read-only GetObjectAttributes; no body). Use for "how was this large object assembled (how many parts)?", "what checksum protects it?", or a storage-class/size check without a HEAD-then-GET dance. GetObjectAttributes is not universally implemented by S3-compatible providers → attributes_status='provider_unsupported' on gap (fall back to head_object). Args: provider_id, bucket, key, version_id?."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        rec("get_object_attributes", provider_id=provider_id, bucket=bucket, key=key)
        res = s3.get_object_attributes(conn, provider_id, bucket, key, version_id or None)
        note("get_object_attributes", f"{bucket}/{key}",
             res.get("attributes_status", res) if res.get("success") else res)
        return _out(res)

    @function_tool
    def diagnose_presigned_url(url: str) -> str:
        """Diagnose a PRESIGNED URL the user pasted — pure parsing, NO network request, NO credential ever echoed. Extracts: signature version (v4/v2), whether it is EXPIRED (computed from X-Amz-Date + X-Amz-Expires, or the V2 epoch), the credential SCOPE (date/region/service — the key id and signature are dropped entirely), signed headers, addressing style, and a `problems` list (url_expired / issued_in_future_check_clock_skew / expires_exceeds_v4_7day_max / sigv2_legacy_many_providers_reject / …). Use for "my presigned URL returns 403/AccessDenied" — it turns the interview into a computation (expired? wrong region scope vs the bucket's region? clock skew?). Args: url (the full presigned URL)."""
        rec("diagnose_presigned_url")
        res = s3.diagnose_presigned_url(url)
        note("diagnose_presigned_url", res.get("host") or "url",
             ("expired" if res.get("expired") else ", ".join(res.get("problems") or []) or "parsed")
             if res.get("success") else "invalid")
        return _out(res)

    @function_tool
    def list_upload_parts(provider_id: str, bucket: str, key: str, upload_id: str,
                          max_parts: int = 1000, part_number_marker: int = 0) -> str:
        """List the PARTS of one in-progress multipart upload (read-only ListParts; no bodies). list_multipart_uploads shows THAT an upload is stuck; this shows how much it holds — part count, bytes accrued, first/last part times, ≤20 sample parts — i.e. the concrete "this abandoned upload has held N GB since <date>". An upload can have 10,000 parts: when is_truncated this is ONE page, so page with next_part_number_marker before quoting total_bytes. Listing only — aborting is a mutation and does not exist here. Args: provider_id, bucket, key, upload_id (from list_multipart_uploads), max_parts? (up to 1000), part_number_marker?."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        rec("list_upload_parts", provider_id=provider_id, bucket=bucket, key=key)
        res = s3.list_upload_parts(conn, provider_id, bucket, key, upload_id, max_parts,
                                   part_number_marker=part_number_marker or None)
        note("list_upload_parts", f"{bucket}/{key}",
             f"{res.get('part_count', 0)} parts" if res.get("success") else res)
        return _out(res)

    @function_tool
    def test_conditional_get(provider_id: str, bucket: str, key: str, etag: str) -> str:
        """Probe whether a cached ETag still matches the stored object (read-only HeadObject with If-None-Match; NO body either way). Read the result from `etag_matches`, NOT the status code: 304 → etag_matches=true (unchanged — stale data is a cache/CDN problem, not the store); 200 with a DIFFERENT current_etag → etag_matches=false (the object really changed); 200 with the SAME etag → etag_matches=true + error_code="provider_unsupported" (the provider ignored If-None-Match — many S3-compatible stores do; the object is unchanged and conditional requests aren't supported here, so don't report a change). Doubles as a provider-compatibility probe for conditional-header support. Use for "I'm seeing stale/old data" or "did this object change?". Args: provider_id, bucket, key, etag (the cached ETag to test, quotes optional)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        denial = scope_denial(p, bucket, key=key)
        if denial:
            return _err(denial)
        rec("test_conditional_get", provider_id=provider_id, bucket=bucket, key=key)
        res = s3.test_conditional_get(conn, provider_id, bucket, key, etag)
        if not res.get("success"):
            label = "error"
        elif res.get("error_code") == s3.PROVIDER_UNSUPPORTED:
            label = "unchanged (provider ignored If-None-Match)"
        elif res.get("etag_matches"):
            label = f"unchanged ({res.get('status_code', 304)})"
        else:
            label = f"changed ({res.get('status_code', 200)})"
        note("test_conditional_get", f"{bucket}/{key}", label)
        return _out(res)

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
                        "Report the range behavior you already measured; if a specific object "
                        "still needs testing, pick the most relevant one and propose continuing. "
                        "This budget resets on the next turn.")
        rec("test_range_get", provider_id=provider_id, bucket=bucket, key=key, range_header=range_header)
        res = s3.test_range_get(conn, provider_id, bucket, key, range_header)
        range_budget["n"] += 1
        note("test_range_get", f"{bucket}/{key}", res)
        return _out(res)

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
                f"{_MAX_PREVIEW_BYTES // (1024 * 1024)} MiB). Synthesize from the objects you've "
                "already previewed; if one more object is genuinely decisive, pick it and propose "
                "continuing. This budget resets on the next turn."
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
        return _out(res)

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
        return _out(res)

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
                        "Report the latency you measured; if another target still needs probing, pick "
                        "the most relevant one and propose continuing. This budget resets on the next turn.")
        rec("measure_request_latency", provider_id=provider_id, bucket=bucket, key=key, samples=samples)
        res = s3.measure_request_latency(conn, provider_id, bucket, key or None, samples)
        latency_budget["n"] += 1
        note("measure_request_latency", f"{bucket}/{key}" if key else bucket,
             f"p50 {res.get('p50_ms')}ms" if res.get("success") else "error")
        return _out(res)

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
        opened = _unlock_groups_for_skill(body, unlocked)
        if not opened:
            return body
        # A skill's method IS its tool list. Making the agent read "call
        # get_bucket_config_summary" and then spend a whole round-trip asking for
        # the group that contains it would cost more than the gate saves — and a
        # skill that names tools the agent cannot see reads as a broken method.
        return (body + "\n\n[TOOL GROUPS UNLOCKED for this skill: "
                + ", ".join(opened) + " — their tools are callable from your next step.]")

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
        return _out(res)

    @function_tool
    def get_bucket_config_detail(provider_id: str, bucket: str, aspect: str) -> str:
        """Read the SANITIZED RULE DETAIL of one bucket-config aspect (read-only GET). The review tools return a status/boolean; this returns the actual rules a diagnosis needs, so you never have to ask the user for their config. `aspect` is one of: replication, notification, cors, logging, lifecycle, encryption, public_access_block, policy, policy_status, ownership, object_lock, acl, inventory, website, intelligent_tiering, accelerate, request_payment, metrics, analytics. Three are easy to misread: 'policy_status' is AWS's IsPublic verdict for the POLICY ONLY — it does not evaluate ACL grants, so combine it with 'acl' (or use review_bucket_security, which checks both) before answering "is this bucket public?"; 'ownership' BucketOwnerEnforced means ACLs are disabled, the recommended posture; 'object_lock' is the bucket-level WORM default, not a per-object state (use get_object_lock_status for that). ARNs are reduced (no account ids), principals reduced to '*'/'specific', values redacted, ≤20 rules. A provider lacking the API returns status='provider_unsupported', not an error. Args: provider_id, bucket, aspect."""
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
        return _out(res)

    tools = [list_providers, list_buckets, head_bucket, get_bucket_location, list_objects,
             list_object_versions, list_multipart_uploads, list_upload_parts,
             test_credentials, head_object, get_object_lock_status,
             get_object_acl, get_object_tagging, get_object_attributes,
             test_range_get, test_conditional_get, preview_object,
             measure_request_latency, diagnose_presigned_url,
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
        # NOTE: review_bucket_performance_profile is registered separately below —
        # it LISTS objects, so it needs the stricter listing scope gate (the five
        # tools above are bucket-metadata reads and gate at the bucket level).
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
            return _out(res)
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

    @function_tool
    def review_bucket_performance_profile(provider_id: str, bucket: str, prefix: str = "") -> str:
        """Profile a bucket's performance from a BOUNDED object sample (key layout, sizes, storage classes). This LISTS objects, so a prefix-scoped provider must pass an in-scope prefix. Args: provider_id, bucket, prefix? (required if the provider restricts allowed_prefixes)."""
        p = provider(provider_id)
        if p is None:
            return _err("Unknown provider_id. Call list_providers first.")
        # Listing gate (not the bucket-metadata gate): honors allowed_prefixes so
        # a prefix-scoped provider can't have the bucket root sampled out of scope.
        denial = scope_denial(p, bucket, prefix=prefix or None, listing=True)
        if denial:
            return _err(denial)
        rec("review_bucket_performance_profile", provider_id=provider_id, bucket=bucket, prefix=prefix)
        try:
            res = ct.review_bucket_performance_profile(conn, provider_id, bucket, prefix or None)
        except Exception as exc:  # noqa: BLE001 — a tool returns an error string, never raises
            return _err(redact_text(f"review_bucket_performance_profile failed: {exc}"))
        note("review_bucket_performance_profile", bucket,
             "reviewed" if not (isinstance(res, dict) and res.get("error")) else "error")
        return _out(res)

    tools.append(review_bucket_performance_profile)
    return tools
