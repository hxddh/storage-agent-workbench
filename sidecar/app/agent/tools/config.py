"""Bucket configuration tools (v5 registry). Read-only GETs only."""

from __future__ import annotations

from typing import Any, Literal

from ...core import store as core_store
from ...estate import rules
from ...estate import store as estate
from ...s3 import config_tools as ct
from .registry import Scope, current, plural, tool

_BUCKET = Scope()

DetailAspect = Literal["replication", "notification", "cors", "logging", "lifecycle", "encryption",
                       "public_access_block", "policy", "policy_status", "ownership", "object_lock", "acl",
                       "inventory", "website", "intelligent_tiering", "accelerate", "request_payment",
                       "metrics", "analytics"]
ReviewAspect = Literal["summary", "security", "lifecycle", "observability", "cost"]


def _review_summary(res: Any) -> str:
    if not isinstance(res, dict) or res.get("success") is False:
        return "could not read"
    findings = res.get("findings") or []
    issues = {f["issue"]["title"] for f in findings if isinstance(f.get("issue"), dict)}
    if issues:
        return plural(len(issues), "issue")
    bad = [f for f in findings if str(f.get("category", "")).lower() in ("critical", "warning")]
    return plural(len(bad), "warning") if bad else "nothing to fix"


def _profile_summary(res: Any) -> str:
    if not isinstance(res, dict) or res.get("success") is False:
        return "could not read"
    facts = res.get("facts") or {}
    if facts.get("inconclusive"):
        return "inconclusive: could not list objects"
    n = facts.get("sampled_objects")
    return f"sampled {plural(n, 'object')}" if isinstance(n, int) else "profiled"


@tool(group="config", scope=_BUCKET, timeout=45)
def get_bucket_config_detail(bucket: str, aspect: DetailAspect, provider_id: str = "") -> dict[str, Any]:
    """The sanitized rules of one configuration aspect. policy_status is the verdict on the policy only;
    combine it with acl before calling a bucket public.

    Args:
        aspect: The configuration aspect.
    """
    return ct.get_bucket_config_detail(current().conn(), provider_id, bucket, aspect)


@tool(group="config", scope=Scope(prefix="prefix", listing=True), timeout=90, summarize=_profile_summary)
def review_bucket_performance_profile(bucket: str, prefix: str = "", provider_id: str = "") -> dict[str, Any]:
    """Profile key layout, object sizes and storage classes from a bounded object sample.

    Args:
        prefix: Sample under this prefix.
    """
    return ct.review_bucket_performance_profile(current().conn(), provider_id, bucket, prefix or None)


_ASPECTS = {"summary": "get_bucket_config_summary", "security": "review_bucket_security",  # engine reads
            "lifecycle": "review_bucket_lifecycle", "observability": "review_bucket_observability",
            "cost": "review_bucket_cost_optimization"}
_INGESTED = ("security", "lifecycle")  # the aspects whose findings open, resolve or recur estate issues
_ORDER = {"critical": 0, "warning": 1, "opportunity": 2, "good": 3}
# A review finding that asserts an estate Issue, by the finding's title.
_ISSUE_BY_FINDING = {(r.check, t): r for r in rules.RULES for t in r.review_titles}


def issue_label(rule: rules.Rule, lang: str) -> dict[str, str]:
    """The Issue as the estate names it, so the conversation and the home agree."""
    return {"title": rules.title(rule, lang), "severity": rule.severity}


@tool(group="config", scope=_BUCKET, timeout=240, summarize=_review_summary)
def review_bucket_config(bucket: str, aspects: list[ReviewAspect] | None = None,
                         provider_id: str = "") -> dict[str, Any]:
    """Review one bucket's configuration: summary (every readable setting), security (policy, ACL, public
    access block, encryption, CORS), lifecycle, observability (logging, notifications, tags) and cost.
    Findings most severe first; one that is an estate issue carries the issue's title and severity.

    Args:
        aspects: Which aspects to run; omit for all.
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
            rule = _ISSUE_BY_FINDING.get((name, str(f.get("title", "")))) if isinstance(f, dict) else None
            findings.append({**f, "section": name, **({"issue": issue_label(rule, ctx.turn.lang)} if rule else {})})
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
