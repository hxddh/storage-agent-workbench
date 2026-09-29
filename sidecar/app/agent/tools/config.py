"""Bucket configuration tools (v5 registry). Read-only GETs only."""

from __future__ import annotations

from typing import Any

from ...core import store as core_store
from ...estate import store as estate
from ...s3 import config_tools as ct
from .registry import Scope, current, tool

_BUCKET = Scope()


def _review_summary(res: Any) -> str:
    if not isinstance(res, dict) or res.get("success") is False:
        return "could not read"
    findings = res.get("findings") or []
    bad = [f for f in findings if str(f.get("category", "")).lower() in ("critical", "warning")]
    return f"{len(bad)} to fix · {len(findings)} findings" if findings else "reviewed"


@tool(group="config", scope=_BUCKET, timeout=45)
def get_bucket_config_detail(provider_id: str, bucket: str, aspect: str) -> dict[str, Any]:
    """Read the sanitized rule detail of one configuration aspect (read-only GET) so you never have to ask
    the user for their config. aspect is one of: replication, notification, cors, logging, lifecycle,
    encryption, public_access_block, policy, policy_status, ownership, object_lock, acl, inventory,
    website, intelligent_tiering, accelerate, request_payment, metrics, analytics. 'policy_status' is
    AWS's verdict for the POLICY only (combine with 'acl', or review_bucket_config's security aspect,
    before saying a bucket is public); BucketOwnerEnforced ownership means ACLs are disabled. ARNs
    reduced, values redacted, at most 20 rules.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        aspect: One configuration aspect.
    """
    return ct.get_bucket_config_detail(current().conn(), provider_id, bucket, aspect)


@tool(group="config", scope=Scope(prefix="prefix", listing=True), timeout=90, summarize=_review_summary)
def review_bucket_performance_profile(provider_id: str, bucket: str, prefix: str = "") -> dict[str, Any]:
    """Profile a bucket's performance from a bounded object sample: key layout, sizes, storage classes.
    This lists objects, so a prefix-scoped provider needs an in-scope prefix.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        prefix: Sample under this prefix.
    """
    return ct.review_bucket_performance_profile(current().conn(), provider_id, bucket, prefix or None)


_ASPECTS = {"summary": "get_bucket_config_summary", "security": "review_bucket_security",  # engine reads
            "lifecycle": "review_bucket_lifecycle", "observability": "review_bucket_observability",
            "cost": "review_bucket_cost_optimization"}
_INGESTED = ("security", "lifecycle")  # the aspects whose findings open, resolve or recur estate issues
_ORDER = {"critical": 0, "warning": 1, "opportunity": 2, "good": 3}


@tool(group="config", scope=_BUCKET, timeout=240, summarize=_review_summary)
def review_bucket_config(provider_id: str, bucket: str, aspects: list[str] | None = None) -> dict[str, Any]:
    """Review one bucket's configuration with read-only GETs. Omit aspects for the full review, or name
    the ones to run: summary (every readable setting with an overall status); security (policy with
    anonymous / wildcard principals and AWS's public verdict, ACL grants, public access block, default
    encryption, CORS); lifecycle (multipart cleanup, expiration, transitions, noncurrent versions);
    observability (logging, event notifications, tagging); cost (transitions, noncurrent versions,
    incomplete uploads, cost-attribution tags). Returns each aspect's status and every finding, most
    severe first; security and lifecycle findings feed the estate's issues. The performance profile is
    separate because it lists objects.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        aspects: Any of summary, security, lifecycle, observability, cost. Omit for all.
    """
    unknown = sorted(set(aspects or ()) - set(_ASPECTS))
    if unknown:
        return {"error": f"Unknown aspect {', '.join(unknown)}. Use any of: {', '.join(_ASPECTS)}."}
    chosen = [a for a in _ASPECTS if not aspects or a in aspects]
    ctx = current()
    conn = ctx.conn()
    out: dict[str, Any] = {"success": True, "bucket": bucket, "aspects": chosen, "sections": {}}
    findings: list[dict[str, Any]] = []
    for name in chosen:
        if ctx.cancelled:
            out["stopped"] = True
            break
        try:
            res = getattr(ct, _ASPECTS[name])(conn, provider_id, bucket)
        except Exception as exc:  # noqa: BLE001 — one aspect never sinks the review
            res = {"success": False, "error_code": type(exc).__name__}
        out["sections"][name] = {k: v for k, v in (res or {}).items() if k != "findings"}
        for f in (res or {}).get("findings") or []:
            findings.append({**f, "section": name})
        if name in _INGESTED:
            # The estate learns from what this call read, aspect by aspect — never
            # from the model's prose, and never about an aspect it did not run.
            try:
                estate.ingest_review(conn, provider_id, bucket, {name: res}, task_id=ctx.task_id)
            except Exception:  # noqa: BLE001 — the estate never fails a tool
                pass
    if len(chosen) == 1 and out["sections"].get(chosen[0], {}).get("success") is False:
        out["success"] = False  # one aspect asked for and it could not be read
        out["error_code"] = out["sections"][chosen[0]].get("error_code")
    findings.sort(key=lambda f: _ORDER.get(str(f.get("category", "")).lower(), 2))
    out["findings"] = findings[:80]
    if ctx.task_id:  # the MCP bridge has no task to keep an output in
        what = "" if len(chosen) == len(_ASPECTS) else f" ({', '.join(chosen)})"
        core_store.add_artifact(conn, kind="review", title=f"Configuration review{what} · {bucket}",
                                task_id=ctx.task_id, turn_id=ctx.turn_id, provider_id=provider_id,
                                payload={"bucket": bucket, "aspects": chosen, "findings": findings[:200]})
    return out
