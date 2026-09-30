"""Account-wide tools (v5 registry): survey, compare with the last survey."""

from __future__ import annotations

import json
from typing import Any

from ...core import store as core_store
from ...engines import survey
from ...estate import rules
from ...estate import store as estate
from ...providers import clouds
from .registry import MODEL_CHARS_CAP, Scope, current, plural, tool

_ACCOUNT = Scope(bucket=None)
_MODEL_BUCKET_ROWS = 150
_ISSUE_NAMES = 5  # an issue kind names its buckets when it has at most this many
_ENVELOPE_SLACK = 200  # the untrusted-data envelope and the truncation note
# The posture a row carries, in column order (the survey's own field names).
_ROW_FIELDS = ("region", "access_status", "publicly_exposed", "policy_is_public", "encryption_status",
               "public_access_block_status", "lifecycle_status", "versioning_status", "logging_status",
               "inventory_status", "evidence", "issues")


def _survey_summary(r: Any) -> str:
    """"12 buckets, 2 unreadable; 1 public" — what the user needs from the row."""
    if not isinstance(r, dict) or not r.get("success"):
        return str((r or {}).get("error_code") or (r or {}).get("error") or "could not survey")
    cov = r.get("coverage") or {}
    n = int(cov.get("surveyed") or 0)
    unreadable = int(cov.get("unreadable") or 0)
    head = plural(n, "bucket") + (f", {unreadable} unreadable" if unreadable else ", all readable" if n else "")
    public = next((int(i.get("buckets") or 0) for i in r.get("issues") or [] if i.get("code") == "public_exposure"), 0)
    unknown = int(cov.get("exposure_unknown") or 0)
    tail = f"{public} public" if public else f"public unknown for {unknown}" if unknown else "none public"
    return f"{head}; {tail}" if n else head


def _row(b: dict[str, Any], codes: list[str]) -> dict[str, Any]:
    row = {k: b.get(k) for k in _ROW_FIELDS[:-2]}
    sources = sorted({str(s.get("source_type")) for s in b.get("evidence_sources") or []
                      if isinstance(s, dict) and s.get("status") == "available"})
    row["evidence"] = sources or None
    row["issues"] = codes or None
    return row


def _compact(profile: dict[str, Any], lang: str, *, estate_changes: dict[str, int] | None = None,
             max_chars: int = MODEL_CHARS_CAP) -> dict[str, Any]:
    """What the model reads, key facts first: every issue kind found (the estate's
    own title and severity, how many buckets, and which when few), what the
    estate recorded, the coverage; then the buckets as columns and rows — a
    value every row shares is stated once, a column no row fills is left out.
    Rows are what gets cut to fit ``max_chars``, most severe kept first; the
    facts above them never are."""
    if not profile.get("success"):
        return {k: profile.get(k) for k in ("success", "list_status", "error_code", "error_message_sanitized",
                                            "summary_text") if profile.get(k) is not None}
    buckets = [b for b in profile.get("buckets") or [] if isinstance(b, dict)]
    found: dict[str, list[str]] = {}
    rows: list[tuple[int, str, dict[str, Any]]] = []
    for b in buckets:
        codes = sorted(code for code, present in rules.evaluate_posture(b).items() if present)
        for code in codes:
            found.setdefault(code, []).append(str(b.get("bucket_name")))
        worst = min((rules.SEVERITY_RANK[rules.BY_CODE[c].severity] for c in codes), default=9)
        rows.append((worst, str(b.get("bucket_name")), _row(b, codes)))
    rows.sort(key=lambda r: (r[0], r[1]))

    issues = []
    for code, names in found.items():
        rule = rules.BY_CODE[code]
        issues.append({"code": code, "title": rules.title(rule, lang), "severity": rule.severity,
                       "buckets": len(names), **({"names": names} if len(names) <= _ISSUE_NAMES else {})})
    issues.sort(key=lambda i: (rules.SEVERITY_RANK[i["severity"]], -i["buckets"], i["code"]))
    summary = profile.get("summary") or {}
    coverage: dict[str, Any] = {"visible": profile.get("visible"), "surveyed": profile.get("processed"),
                                "whole_account": bool(profile.get("whole_account"))}
    unreadable = sum(1 for b in buckets if b.get("access_status") not in ("available", None))
    extras = {"truncated": bool(profile.get("truncated")), "unreadable": unreadable,
              "exposure_unknown": int(summary.get("exposure_unknown_count") or 0)}
    coverage.update({k: v for k, v in extras.items() if v})

    out: dict[str, Any] = {"success": True, "issues": issues}
    if estate_changes is not None:
        out["estate_changes"] = {k: v for k, v in estate_changes.items() if v} or {"opened": 0}
    out["coverage"] = coverage

    # Columns: a value every row shares goes to `common`; a column nobody fills is dropped.
    body = [r[2] for r in rows]
    common = {f: body[0][f] for f in _ROW_FIELDS
              if len(body) > 1 and body[0][f] is not None and all(r[f] == body[0][f] for r in body)}
    columns = ["bucket"] + [f for f in _ROW_FIELDS if f not in common and any(r[f] is not None for r in body)]
    table: dict[str, Any] = {"columns": columns}
    if common:
        table["common"] = common
    table["rows"] = []
    out["buckets"] = table
    budget = max_chars - _ENVELOPE_SLACK - 160  # the omitted-rows note
    size = len(json.dumps(out, separators=(",", ":"), default=str, ensure_ascii=False))
    kept = 0
    for _, name, row in rows[:_MODEL_BUCKET_ROWS]:
        cells = [name, *(row[c] for c in columns[1:])]
        cost = len(json.dumps(cells, separators=(",", ":"), default=str, ensure_ascii=False)) + 1
        if size + cost > budget:
            break
        table["rows"].append(cells)
        size += cost
        kept += 1
    if kept < len(rows):
        table["rows_omitted"] = len(rows) - kept
        table["note"] = ("Rows run most severe first; the omitted ones are stored: use query_estate with "
                         "survey_filter to list them.")
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
        estate_changes = {kind: sum(1 for c in changes if c["change"] == kind)
                          for kind in ("opened", "recurred", "resolved")}
        return _compact(profile, ctx.turn.lang, estate_changes=estate_changes, max_chars=ctx.turn.model_chars)
    return _compact(profile, ctx.turn.lang, max_chars=ctx.turn.model_chars)


@tool(group="account", scope=_ACCOUNT, timeout=30,
      summarize=lambda r: ("compared" if r.get("comparable") else "no earlier survey")
      if isinstance(r, dict) and r.get("success") else "could not compare")
def compare_to_last_survey(provider_id: str = "") -> dict[str, Any]:
    """What changed since the previous survey of this account (buckets added or removed, posture changes),
    from stored surveys; no new scan.
    """
    surveys = latest_surveys(current().conn(), provider_id, 2)
    if len(surveys) < 2:
        return {"success": True, "comparable": False,
                "note": "Fewer than two surveys of this account exist; run survey_account first."}
    return {"success": True, "comparable": True, "older_at": surveys[1]["surveyed_at"],
            "newer_at": surveys[0]["surveyed_at"], **survey.diff_profiles(surveys[1], surveys[0])}
