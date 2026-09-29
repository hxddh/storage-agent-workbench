"""Account-wide tools (v5 registry): survey, compare with the last survey."""

from __future__ import annotations

from typing import Any

from ...core import store as core_store
from ...engines import survey
from ...estate import store as estate
from ...providers import clouds
from .registry import Scope, current, tool

_ACCOUNT = Scope(bucket=None)
_MODEL_BUCKET_ROWS = 150


def _compact(profile: dict[str, Any]) -> dict[str, Any]:
    """What the model reads: the summary plus one short row per bucket."""
    rows = []
    for b in (profile.get("buckets") or [])[:_MODEL_BUCKET_ROWS]:
        rows.append({k: b.get(k) for k in ("bucket_name", "region", "access_status", "publicly_exposed",
                                           "encryption_status", "public_access_block_status", "lifecycle_status",
                                           "versioning_status", "logging_status", "inventory_status")})
    out = {k: profile.get(k) for k in ("success", "visible", "processed", "truncated", "whole_account",
                                       "summary_text", "summary", "list_status", "error_code",
                                       "error_message_sanitized")}
    out["buckets"] = rows
    if len(profile.get("buckets") or []) > _MODEL_BUCKET_ROWS:
        out["buckets_note"] = (f"{len(profile['buckets']) - _MODEL_BUCKET_ROWS} more bucket rows are stored; "
                               "use query_estate with survey_filter to filter them.")
    return out


def latest_surveys(conn: Any, provider_id: str, n: int = 2) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT payload, created_at FROM artifacts WHERE kind = 'survey' AND provider_id = ? "
                        "ORDER BY created_at DESC, rowid DESC LIMIT ?", (provider_id, n)).fetchall()
    return [{**core_store.loads(r["payload"], {}), "surveyed_at": r["created_at"]} for r in rows]


@tool(group="account", scope=_ACCOUNT, timeout=900, bounds={"max_buckets": (1, survey.HARD_MAX_BUCKETS)},
      summarize=lambda r: (r.get("summary_text") or "surveyed")[:200] if isinstance(r, dict) else "surveyed")
def survey_account(provider_id: str, max_buckets: int = 100) -> dict[str, Any]:
    """Survey every bucket of a storage account (read-only, bounded to 500 buckets, 4 in parallel): region,
    public exposure, encryption, public access block, lifecycle, versioning, logging and evidence sources
    (inventory / access logs). Honest about coverage: unreadable or unsupported checks are reported as
    undetermined, never as fine. Updates the estate and its issues. Use compare_to_last_survey afterwards
    to say what changed.

    Args:
        provider_id: The provider.
        max_buckets: How many buckets to survey (1-500, default 100).
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
    return {**_compact(profile), **({"estate_changes": profile["estate_changes"]} if "estate_changes" in profile else {})}


@tool(group="account", scope=_ACCOUNT, timeout=30)
def compare_to_last_survey(provider_id: str) -> dict[str, Any]:
    """What changed since the previous survey of this account: buckets added or removed, posture changes
    per bucket (a bucket that became public is flagged first), evidence-source changes. Reuses stored
    surveys — no new scan. Truncated surveys make membership changes unverified, and the result says so.

    Args:
        provider_id: The provider.
    """
    surveys = latest_surveys(current().conn(), provider_id, 2)
    if len(surveys) < 2:
        return {"success": True, "comparable": False,
                "note": "Fewer than two surveys of this account exist; run survey_account first."}
    return {"success": True, "comparable": True, "older_at": surveys[1]["surveyed_at"],
            "newer_at": surveys[0]["surveyed_at"], **survey.diff_profiles(surveys[1], surveys[0])}
