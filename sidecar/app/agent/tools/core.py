"""Core tools (v5 registry): skills, the estate, the conclusion."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field

from ...estate import notes as estate_notes
from ...estate import rules
from ...estate import store as estate
from ...skills import context as skill_context
from ..recorder import Finding
from .registry import current, plural, tool

IssueStatus = Literal["active", "care", "all", "open", "fix_proposed", "resolved", "recurred", "accepted"]
SurveyFilter = Literal["all", "public_buckets", "missing_encryption", "missing_public_access_block",
                       "missing_lifecycle", "missing_logging", "no_versioning", "access_denied"]


def _estate_summary(r: Any) -> str:
    if not isinstance(r, dict) or r.get("error"):
        return str((r or {}).get("error") or "could not read")
    if "comparable" in r:
        return "compared with the last survey" if r.get("comparable") else "no earlier survey"
    if "has_survey" in r:
        if not r.get("has_survey"):
            return "no survey yet"
        return f"{int(r.get('matched_count') or 0)} of {plural(int(r.get('total_buckets') or 0), 'bucket')} match"
    return f"{plural(int(r.get('bucket_count') or 0), 'bucket')}, {plural(len(r.get('issues') or []), 'issue')}"


@tool(group="core", core=True, untrusted=False, timeout=15,
      summarize=lambda r: "loaded" if isinstance(r, str) else str((r or {}).get("error", "loaded")))
def read_skill(name: str) -> Any:
    """Load the full method of a skill from the skills catalog.

    Args:
        name: A skill name from the catalog.
    """
    ctx = current()
    if not ctx.budget("loads", 20):
        return {"error": "Skill-load budget for this turn is used up (20). Apply the skills already loaded."}
    body = skill_context.read_skill_text(name)
    if body is None:
        return {"error": "Unknown skill. Use a name from the skills catalog."}
    return body


def _only_account(conn: Any) -> str:
    rows = conn.execute("SELECT id FROM cloud_providers LIMIT 2").fetchall()
    return rows[0]["id"] if len(rows) == 1 else ""


@tool(group="core", core=True, timeout=15, summarize=_estate_summary)
def query_estate(provider_id: str = "", bucket: str = "", status: IssueStatus = "active",
                 survey_filter: SurveyFilter | None = None, since_last_survey: bool = False) -> dict[str, Any]:
    """What earlier work established: known buckets and issues (ids, status). survey_filter: the latest
    survey's buckets by posture; since_last_survey: what changed since the survey before. No new scan.

    Args:
        status: Which issues (active: still to act on).
    """
    conn = current().conn()
    lang = current().turn.lang
    if since_last_survey:
        return _survey_diff(conn, provider_id or _only_account(conn))
    if survey_filter:
        return _survey_query(conn, provider_id or _only_account(conn), survey_filter)
    if status not in ("active", "care", "all", *estate.STATUSES):
        status = "active"
    known = estate.buckets(conn, provider_id or None, limit=300)
    if bucket:
        known = [b for b in known if b["bucket"] == bucket]
    return {"success": True, "buckets": known[:200], "bucket_count": len(known),
            "issues": estate.list_issues(conn, status=status, provider_id=provider_id or None,
                                         bucket=bucket or None, limit=100, lang=lang)}


def _survey_diff(conn: Any, provider_id: str) -> dict[str, Any]:
    """What changed between the two latest stored surveys of one account."""
    from ...engines import survey
    from .account import latest_surveys
    if not provider_id:
        return {"error": "Several storage accounts are configured: since_last_survey needs a provider_id."}
    surveys = latest_surveys(conn, provider_id, 2)
    if len(surveys) < 2:
        return {"success": True, "comparable": False,
                "note": "Fewer than two surveys of this account exist; run survey_account first."}
    return {"success": True, "comparable": True, "older_at": surveys[1]["surveyed_at"],
            "newer_at": surveys[0]["surveyed_at"], **survey.diff_profiles(surveys[1], surveys[0])}


def _survey_query(conn: Any, provider_id: str, survey_filter: str) -> dict[str, Any]:
    """The latest stored survey of one account, filtered by posture."""
    from ...engines import survey
    from .account import latest_surveys
    if survey_filter not in survey.FILTERS:
        return {"error": f"Unknown survey_filter. Use one of: {', '.join(survey.FILTERS)}."}
    if not provider_id:
        return {"error": "Several storage accounts are configured: survey_filter needs a provider_id."}
    surveys = latest_surveys(conn, provider_id, 1)
    if not surveys:
        return {"success": True, "has_survey": False, "note": "No survey of this account yet; run survey_account."}
    return {"has_survey": True, "surveyed_at": surveys[0]["surveyed_at"], **survey.query(surveys[0], survey_filter)}


@tool(group="core", core=True, timeout=15,
      summarize=lambda r: ("fix ready" if r.get("fixable") else "no generated fix") if isinstance(r, dict)
      and r.get("success") else str((r or {}).get("error") or "could not read"))
def fix_preview(issue_id: str) -> dict[str, Any]:
    """An issue's generated fix (AWS CLI, Terraform, API document) and what applying it would change, from
    the evidence the estate holds. The user applies it; say what the preview cannot tell.

    Args:
        issue_id: From query_estate.
    """
    from ...estate import fixpacks
    ctx = current()
    conn = ctx.conn()
    issue = estate.get_issue(conn, issue_id, ctx.turn.lang)
    if issue is None:
        return {"error": "Unknown issue id. Use query_estate to find it."}
    cp = conn.execute("SELECT endpoint_url, region FROM cloud_providers WHERE id = ?",
                      (issue["provider_id"],)).fetchone()
    fix = rules.generate_fix(issue["code"], issue["bucket"], endpoint_url=(cp["endpoint_url"] if cp else None) or None,
                             region=(cp["region"] if cp else None) or None)
    if fix is None:
        return {"success": True, "fixable": False, "issue": issue["title"],
                "note": "The fix depends on intent (who should have access); there is no generated fix."}
    return {"success": True, "fixable": True, "issue": issue["title"], "bucket": issue["bucket"],
            "formats": fix["formats"], "notes": fix["notes"],
            "impact": fixpacks.impact(conn, issue, ctx.turn.lang)}


@tool(group="core", core=True, untrusted=False, timeout=10,
      summarize=lambda r: "kept" if (r or {}).get("success") else str((r or {}).get("error", "")))
def note(text: str, provider_id: str = "", bucket: str = "") -> dict[str, Any]:
    """Keep a durable note later tasks should remember (an owner, an intent, why a setting is deliberate).
    Never secrets or raw data.

    Args:
        text: The note (at most 1000 characters).
        provider_id: The storage account it is about.
        bucket: The bucket it is about (needs provider_id).
    """
    ctx = current()
    if not ctx.budget("notes", 5):
        return {"error": "Note budget for this turn is used up (5)."}
    try:
        n = estate_notes.add(ctx.conn(), text, provider_id=provider_id or None, bucket=bucket or None,
                             source="agent", task_id=ctx.task_id)
    except estate_notes.NoteError as exc:
        return {"error": str(exc)}
    return {"success": True, "note_id": n["id"]}


@tool(group="core", core=True, untrusted=False, special="conclusion", timeout=10)
def record_conclusion(findings: Annotated[list[Finding], Field(max_length=8)] | None = None,
                      next_steps: Annotated[list[str], Field(max_length=4)] | None = None) -> str:
    """Record the turn's findings (most severe first) and/or next steps, once, right before your final
    answer. Shown under the answer.

    Args:
        findings: Only what your tools showed.
        next_steps: Short requests the user could send you next.
    """
    return "recorded"  # handled by the registry (special="conclusion")
