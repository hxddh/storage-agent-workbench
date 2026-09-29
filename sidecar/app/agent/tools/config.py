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


@tool(group="config", scope=_BUCKET, timeout=60)
def get_bucket_config_summary(provider_id: str, bucket: str) -> dict[str, Any]:
    """Summarize a bucket's readable configuration: encryption, versioning, policy, CORS, lifecycle,
    logging and more, with an overall status.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
    """
    return ct.get_bucket_config_summary(current().conn(), provider_id, bucket)


@tool(group="config", scope=_BUCKET, timeout=45)
def get_bucket_config_detail(provider_id: str, bucket: str, aspect: str) -> dict[str, Any]:
    """Read the sanitized rule detail of one configuration aspect (read-only GET) so you never have to ask
    the user for their config. aspect is one of: replication, notification, cors, logging, lifecycle,
    encryption, public_access_block, policy, policy_status, ownership, object_lock, acl, inventory,
    website, intelligent_tiering, accelerate, request_payment, metrics, analytics. 'policy_status' is
    AWS's verdict for the POLICY only (combine with 'acl', or use review_bucket_security, before saying a
    bucket is public); BucketOwnerEnforced ownership means ACLs are disabled. ARNs reduced, values
    redacted, at most 20 rules.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
        aspect: One configuration aspect.
    """
    return ct.get_bucket_config_detail(current().conn(), provider_id, bucket, aspect)


def _review(check: str, fn: Any, provider_id: str, bucket: str) -> dict[str, Any]:
    ctx = current()
    res = fn(ctx.conn(), provider_id, bucket)
    if check in ("security", "lifecycle") and isinstance(res, dict):
        # The estate learns from the review deterministically: issues open,
        # resolve or recur here — never from the model's prose.
        try:
            estate.ingest_review(ctx.conn(), provider_id, bucket, {check: res}, task_id=ctx.task_id)
        except Exception:  # noqa: BLE001 — the estate never fails a tool
            pass
    return res


@tool(group="config", scope=_BUCKET, timeout=90, summarize=_review_summary)
def review_bucket_security(provider_id: str, bucket: str) -> dict[str, Any]:
    """Review a bucket's security posture: policy (anonymous and wildcard principals, AWS public verdict),
    ACL grants, public access block, default encryption, CORS. Findings feed the estate's issues.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
    """
    return _review("security", ct.review_bucket_security, provider_id, bucket)


@tool(group="config", scope=_BUCKET, timeout=90, summarize=_review_summary)
def review_bucket_lifecycle(provider_id: str, bucket: str) -> dict[str, Any]:
    """Review a bucket's lifecycle rules and version cleanup (multipart cleanup, expiration, transitions,
    noncurrent versions). Findings feed the estate's issues.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
    """
    return _review("lifecycle", ct.review_bucket_lifecycle, provider_id, bucket)


@tool(group="config", scope=_BUCKET, timeout=90, summarize=_review_summary)
def review_bucket_observability(provider_id: str, bucket: str) -> dict[str, Any]:
    """Review a bucket's logging, event notifications and tagging.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
    """
    return _review("observability", ct.review_bucket_observability, provider_id, bucket)


@tool(group="config", scope=_BUCKET, timeout=90, summarize=_review_summary)
def review_bucket_cost_optimization(provider_id: str, bucket: str) -> dict[str, Any]:
    """Review a bucket for cost-optimization opportunities (lifecycle, transitions, noncurrent versions,
    incomplete uploads, cost-attribution tags).

    Args:
        provider_id: The provider.
        bucket: The bucket name.
    """
    return _review("cost", ct.review_bucket_cost_optimization, provider_id, bucket)


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


@tool(group="config", scope=_BUCKET, timeout=240, summarize=_review_summary)
def review_bucket_config(provider_id: str, bucket: str) -> dict[str, Any]:
    """Run the full read-only configuration review of one bucket in one call: summary, security,
    lifecycle, observability and cost (the performance profile is separate because it lists objects).
    Returns every finding, most severe first, and feeds the estate's issues.

    Args:
        provider_id: The provider.
        bucket: The bucket name.
    """
    ctx = current()
    conn = ctx.conn()
    out: dict[str, Any] = {"success": True, "bucket": bucket, "sections": {}}
    findings: list[dict[str, Any]] = []
    for name, fn in (("summary", ct.get_bucket_config_summary), ("security", ct.review_bucket_security),
                     ("lifecycle", ct.review_bucket_lifecycle), ("observability", ct.review_bucket_observability),
                     ("cost", ct.review_bucket_cost_optimization)):
        if ctx.cancelled:
            out["stopped"] = True
            break
        try:
            res = fn(conn, provider_id, bucket)
        except Exception as exc:  # noqa: BLE001 — one aspect never sinks the review
            res = {"success": False, "error_code": type(exc).__name__}
        out["sections"][name] = {k: v for k, v in (res or {}).items() if k != "findings"}
        for f in (res or {}).get("findings") or []:
            findings.append({**f, "section": name})
        if name in ("security", "lifecycle"):
            try:
                estate.ingest_review(conn, provider_id, bucket, {name: res}, task_id=ctx.task_id)
            except Exception:  # noqa: BLE001
                pass
    order = {"critical": 0, "warning": 1, "opportunity": 2, "good": 3}
    findings.sort(key=lambda f: order.get(str(f.get("category", "")).lower(), 2))
    out["findings"] = findings[:80]
    core_store.add_artifact(conn, kind="review", title=f"Configuration review · {bucket}", task_id=ctx.task_id,
                            turn_id=ctx.turn_id, provider_id=provider_id,
                            payload={"bucket": bucket, "findings": findings[:200]})
    return out
