"""Bucket configuration: one review tool (v10). Read-only GETs, plus a bounded
object sample for the performance aspect."""

from __future__ import annotations

from typing import Any, Literal

from ...core import store as core_store
from ...estate import rules
from ...estate import store as estate
from ...s3 import config_tools as ct
from .registry import Scope, current, plural, tool
from .storage import quiet

DetailAspect = Literal["replication", "notification", "cors", "logging", "lifecycle", "encryption",
                       "public_access_block", "policy", "policy_status", "ownership", "object_lock", "acl",
                       "inventory", "website", "intelligent_tiering", "accelerate", "request_payment",
                       "metrics", "analytics"]
ReviewAspect = Literal["summary", "security", "lifecycle", "observability", "cost", "performance"]

_ASPECTS = {"summary": "get_bucket_config_summary", "security": "review_bucket_security",  # engine reads
            "lifecycle": "review_bucket_lifecycle", "observability": "review_bucket_observability",
            "cost": "review_bucket_cost_optimization"}
_ALL = (*_ASPECTS, "performance")
_DEFAULT = tuple(_ASPECTS)  # performance samples objects: only when asked
_INGESTED = ("security", "lifecycle")  # the aspects whose findings open, resolve or recur estate issues
_ORDER = {"critical": 0, "warning": 1, "opportunity": 2, "good": 3}
# A review finding that asserts an estate Issue, by the finding's title.
_ISSUE_BY_FINDING = {(r.check, t): r for r in rules.RULES for t in r.review_titles}
# The cost aspect re-reads lifecycle and versioning: with the lifecycle aspect in
# the same review, these say the same thing twice.
_COST_REPEATS = frozenset({"No lifecycle for cost control", "No transition or expiration rules",
                           "No incomplete-multipart cleanup", "Noncurrent versions never expire"})
_COST_REPEATED_FACTS = frozenset({"has_transition", "has_expiration", "has_abort_mpu", "has_noncurrent_expiration",
                                  "has_rules", "lifecycle_status", "versioning_enabled"})


def _as_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    return [str(v) for v in value] if isinstance(value, (list, tuple)) else [str(value)]


def _samples_objects(args: dict[str, Any]) -> bool:
    return "performance" in _as_list(args.get("aspects"))


def issue_label(rule: rules.Rule, lang: str) -> dict[str, str]:
    """The Issue as the estate names it, so the conversation and the home agree."""
    return {"title": rules.title(rule, lang), "severity": rule.severity}


def _review_summary(res: Any) -> str:
    if not isinstance(res, dict) or res.get("error"):
        return str((res or {}).get("error") or "could not read")
    if res.get("success") is False:
        return str(res.get("error_code") or "could not read")
    findings = res.get("findings") or []
    issues = {f["issue"]["title"] for f in findings if isinstance(f.get("issue"), dict)}
    if issues:
        return plural(len(issues), "issue")
    bad = [f for f in findings if str(f.get("category", "")).lower() in ("critical", "warning")]
    if bad:
        return plural(len(bad), "warning")
    if not findings and res.get("detail"):
        d = next(iter(res["detail"].values()), {})
        return f"{d.get('aspect', 'detail')}: {d.get('status', 'read')}"
    return "nothing to fix"


@tool(group="config", scope=Scope(prefix="prefix", listing=_samples_objects), timeout=240,
      summarize=_review_summary)
def review_bucket_config(bucket: str, aspects: list[ReviewAspect] | None = None, detail: DetailAspect | None = None,
                         prefix: str = "", provider_id: str = "") -> dict[str, Any]:
    """Review one bucket's configuration: summary, security (policy, ACL, public access block, encryption,
    CORS), lifecycle, observability, cost, performance (samples objects). detail: one aspect's rules.

    Args:
        aspects: Omit for all but performance.
        detail: Alone, only this read runs. policy_status is the policy verdict only; check acl too.
        prefix: performance: sample under it.
    """
    asked = _as_list(aspects)
    unknown = sorted(set(asked) - set(_ALL))
    if unknown:
        return {"error": f"Unknown aspect {', '.join(unknown)}. Use any of: {', '.join(_ALL)}."}
    if detail and detail not in DetailAspect.__args__:  # type: ignore[attr-defined]
        return {"error": f"Unknown detail {detail}. Use one of: {', '.join(DetailAspect.__args__)}."}  # type: ignore[attr-defined]
    chosen = [a for a in _ALL if a in asked] if asked else ([] if detail else list(_DEFAULT))
    ctx = current()
    conn = ctx.conn()
    out: dict[str, Any] = {"success": True, "bucket": bucket, "aspects": chosen, "sections": {}}
    findings: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for name in chosen:
        if ctx.cancelled:
            out["stopped"] = True
            break
        try:
            if name == "performance":
                res = ct.review_bucket_performance_profile(conn, provider_id, bucket, prefix or None)
            else:
                res = getattr(ct, _ASPECTS[name])(conn, provider_id, bucket)
        except Exception as exc:  # noqa: BLE001 — one aspect never sinks the review
            res = {"success": False, "error_code": type(exc).__name__}
        res = quiet(res or {})
        section = {k: v for k, v in res.items() if k != "findings"}
        repeats = name == "cost" and "lifecycle" in chosen
        if repeats and isinstance(section.get("facts"), dict):
            section["facts"] = {k: v for k, v in section["facts"].items() if k not in _COST_REPEATED_FACTS}
        out["sections"][name] = section
        for f in res.get("findings") or []:
            if not isinstance(f, dict):
                continue
            title = str(f.get("title", ""))
            if (repeats and title in _COST_REPEATS) or (str(f.get("category")), title) in seen:
                continue
            seen.add((str(f.get("category")), title))
            rule = _ISSUE_BY_FINDING.get((name, title))
            findings.append({**f, "section": name, **({"issue": issue_label(rule, ctx.turn.lang)} if rule else {})})
        if name in _INGESTED:
            # The estate learns from what this call read, aspect by aspect — never
            # from the model's prose, and never about an aspect it did not run.
            try:
                estate.ingest_review(conn, provider_id, bucket, {name: res}, task_id=ctx.task_id)
            except Exception:  # noqa: BLE001 — the estate never fails a tool
                pass
    if detail and not ctx.cancelled:
        try:
            got = ct.get_bucket_config_detail(conn, provider_id, bucket, detail)
        except Exception as exc:  # noqa: BLE001
            got = {"success": False, "error_code": type(exc).__name__}
        got = quiet(got)
        got.pop("provider_id", None)
        got.pop("bucket", None)
        out["detail"] = {detail: got}
    reads = list(out["sections"].values()) + list((out.get("detail") or {}).values())
    if len(reads) == 1 and reads[0].get("success") is False:
        out["success"] = False  # one read asked for and it could not be made
        out["error_code"] = reads[0].get("error_code")
    findings.sort(key=lambda f: _ORDER.get(str(f.get("category", "")).lower(), 2))
    out["findings"] = findings[:80]
    if ctx.task_id and chosen:  # the MCP bridge has no task to keep an output in
        what = "" if chosen == list(_DEFAULT) else f" ({', '.join(chosen)})"
        core_store.add_artifact(conn, kind="review", title=f"Configuration review{what} · {bucket}",
                                task_id=ctx.task_id, turn_id=ctx.turn_id, provider_id=provider_id,
                                payload={"bucket": bucket, "aspects": chosen, "findings": findings[:200]})
    return out
