"""Account-wide tools: the survey (v10: comparing surveys is query_estate(since_last_survey=true))."""

from __future__ import annotations

from typing import Any

from ...core import store as core_store
from ...engines import survey
from ...estate import rules
from ...estate import store as estate
from ...providers import clouds
from .registry import Scope, current, plural, tool

_ACCOUNT = Scope(bucket=None)
_MODEL_BUCKET_ROWS = 150


def _survey_summary(r: Any) -> str:
    """"12 buckets, 2 unreadable; 1 public" — what the user needs from the row."""
    if not isinstance(r, dict) or not r.get("success"):
        return str((r or {}).get("error_code") or (r or {}).get("error") or "could not survey")
    rows = r.get("buckets") or []
    n = int(r.get("processed") or len(rows))
    unreadable = sum(1 for b in rows if b.get("access_status") not in ("available", None))
    head = plural(n, "bucket") + (f", {unreadable} unreadable" if unreadable else ", all readable" if n else "")
    s = r.get("summary") or {}
    public, unknown = int(s.get("public_bucket_count") or 0), int(s.get("exposure_unknown_count") or 0)
    tail = f"{public} public" if public else f"public unknown for {unknown}" if unknown else "none public"
    return f"{head}; {tail}" if n else head


def _compact(profile: dict[str, Any], lang: str) -> dict[str, Any]:
    """What the model reads: the summary plus one short row per bucket, with the
    estate issue each row asserts (the estate's own title and severity)."""
    rows = []
    found: dict[str, dict[str, str]] = {}
    for b in (profile.get("buckets") or [])[:_MODEL_BUCKET_ROWS]:
        row = {k: b.get(k) for k in ("bucket_name", "region", "access_status", "publicly_exposed",
                                     "encryption_status", "public_access_block_status", "lifecycle_status",
                                     "versioning_status", "logging_status", "inventory_status")}
        codes = [code for code, present in rules.evaluate_posture(b).items() if present]
        if codes:
            row["issues"] = codes
            for code in codes:
                rule = rules.BY_CODE[code]
                found[code] = {"title": rules.title(rule, lang), "severity": rule.severity}
        rows.append(row)
    out = {k: profile.get(k) for k in ("success", "visible", "processed", "truncated", "whole_account",
                                       "summary_text", "summary", "list_status", "error_code",
                                       "error_message_sanitized")}
    out["buckets"] = rows
    if found:
        out["issues"] = found
    if len(profile.get("buckets") or []) > _MODEL_BUCKET_ROWS:
        out["buckets_note"] = (f"{len(profile['buckets']) - _MODEL_BUCKET_ROWS} more bucket rows are stored; "
                               "use query_estate with survey_filter to filter them.")
    return out


def latest_surveys(conn: Any, provider_id: str, n: int = 2) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT payload, created_at FROM artifacts WHERE kind = 'survey' AND provider_id = ? "
                        "ORDER BY created_at DESC, rowid DESC LIMIT ?", (provider_id, n)).fetchall()
    return [{**core_store.loads(r["payload"], {}), "surveyed_at": r["created_at"]} for r in rows]


@tool(group="account", core=True, scope=_ACCOUNT, timeout=900,
      bounds={"max_buckets": (1, survey.HARD_MAX_BUCKETS)}, summarize=_survey_summary)
def survey_account(max_buckets: int = 100, provider_id: str = "") -> dict[str, Any]:
    """Survey every bucket of the account: region, exposure, encryption, public access block, lifecycle,
    versioning, logging, evidence sources. Unreadable checks are undetermined, never fine. Updates the estate.

    Args:
        max_buckets: How many buckets to survey (1-500).
    """
    ctx = current()
    conn = ctx.conn()
    cloud = clouds.get(conn, provider_id)
    profile = survey.run(conn, provider_id, max_buckets=max_buckets,
                         allowed_buckets=cloud.allowed_buckets if cloud else None,
                         allowed_prefixes=cloud.allowed_prefixes if cloud else None,
                         progress=ctx.progress, cancelled=lambda: ctx.cancelled)
    if profile.get("success"):
        core_store.add_artifact(conn, kind="survey", title=f"Account survey · {cloud.name if cloud else provider_id}",
                                task_id=ctx.task_id, turn_id=ctx.turn_id, provider_id=provider_id, payload=profile)
        changes = estate.ingest_survey(conn, provider_id, profile, task_id=ctx.task_id)
        profile["estate_changes"] = {"opened": sum(1 for c in changes if c["change"] == "opened"),
                                     "recurred": sum(1 for c in changes if c["change"] == "recurred"),
                                     "resolved": sum(1 for c in changes if c["change"] == "resolved")}
    return {**_compact(profile, ctx.turn.lang),
            **({"estate_changes": profile["estate_changes"]} if "estate_changes" in profile else {})}
