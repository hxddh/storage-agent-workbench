"""The storage estate: buckets, issues and their lifecycle (v4.0).

What the deterministic engines learn about an account outlives the task that
learned it. After an account survey or a bucket config review completes,
``ingest_run`` projects its persisted, sanitized output onto:

* ``estate_buckets`` — one row per (provider, bucket) with a posture
  projection (status enums and booleans only) and when it was last checked;
* ``issues`` — one row per (provider, bucket, rule code), opened, resolved
  and re-opened (``recurred``) only by deterministic observations
  (``rules.py``), never by model prose;
* ``issue_events`` — the append-only lifecycle of each issue.

Everything here reads rows the engines already sanitized and bounded; nothing
here talks to storage (read-only re-checks live in ``verify.py``).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from ..repositories import utcnow
from ..security.redaction import redact_text
from . import rules

ACTIVE = ("open", "fix_proposed", "recurred", "accepted")
STATUSES = ("open", "fix_proposed", "resolved", "recurred", "accepted")
_MAX_ESTATE_BUCKETS = 5000
_MAX_LIST = 500


def _dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), default=str, ensure_ascii=False)


def _loads(raw: str | None, default: Any = None) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


def fingerprint(provider_id: str, bucket: str, code: str) -> str:
    return f"{provider_id}:{bucket}:{code}"


# --- buckets ------------------------------------------------------------------

def upsert_bucket(conn: sqlite3.Connection, provider_id: str, bucket: str, *,
                  region: str | None = None, posture: dict[str, Any] | None = None,
                  run_id: str | None = None, task_id: str | None = None) -> None:
    """Record that ``bucket`` was checked now. A posture replaces the stored
    one only when given (a config review re-checks without a full posture)."""
    now = utcnow()
    existing = conn.execute(
        "SELECT posture_json_sanitized, region FROM estate_buckets "
        "WHERE provider_id = ? AND bucket = ?", (provider_id, bucket)).fetchone()
    posture_json = _dumps(rules.posture_projection(posture)) if posture is not None else (
        existing["posture_json_sanitized"] if existing else None)
    region = region or (existing["region"] if existing else None)
    conn.execute(
        "INSERT INTO estate_buckets (provider_id, bucket, region, posture_json_sanitized, "
        "last_checked_at, source_run_id, source_task_id) VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(provider_id, bucket) DO UPDATE SET region = excluded.region, "
        "posture_json_sanitized = excluded.posture_json_sanitized, "
        "last_checked_at = excluded.last_checked_at, source_run_id = excluded.source_run_id, "
        "source_task_id = COALESCE(excluded.source_task_id, estate_buckets.source_task_id)",
        (provider_id, bucket, region, posture_json, now, run_id, task_id))


def _forget_bucket(conn: sqlite3.Connection, provider_id: str, bucket: str, *,
                   source: str, run_id: str | None) -> list[dict[str, Any]]:
    changes = []
    for row in conn.execute(
            "SELECT id FROM issues WHERE provider_id = ? AND bucket = ? AND status IN "
            f"({','.join('?' * len(ACTIVE))})", (provider_id, bucket, *ACTIVE)).fetchall():
        _transition(conn, row["id"], "resolved", source=source,
                    detail={"reason": "bucket_no_longer_listed", "run_id": run_id})
        changes.append({"issue_id": row["id"], "change": "resolved"})
    conn.execute("DELETE FROM estate_buckets WHERE provider_id = ? AND bucket = ?",
                 (provider_id, bucket))
    return changes


# --- issue lifecycle ------------------------------------------------------------

def _event(conn: sqlite3.Connection, issue_id: str, kind: str, *, source: str | None,
           detail: dict[str, Any] | None = None) -> None:
    conn.execute(
        "INSERT INTO issue_events (issue_id, kind, source, detail_json_sanitized, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (issue_id, kind, source, _dumps(detail) if detail else None, utcnow()))


def _transition(conn: sqlite3.Connection, issue_id: str, status: str, *, source: str,
                detail: dict[str, Any] | None = None) -> None:
    now = utcnow()
    if status == "resolved":
        conn.execute("UPDATE issues SET status = 'resolved', resolved_at = ?, resolved_by = ?, "
                     "updated_at = ? WHERE id = ?", (now, source, now, issue_id))
    else:
        conn.execute("UPDATE issues SET status = ?, resolved_at = NULL, resolved_by = NULL, "
                     "updated_at = ? WHERE id = ?", (status, now, issue_id))
    _event(conn, issue_id, status, source=source, detail=detail)


def observe(conn: sqlite3.Connection, provider_id: str, bucket: str,
            verdicts: dict[str, rules.Verdict], details: dict[str, str] | None = None, *,
            source: str, run_id: str | None = None,
            task_id: str | None = None) -> list[dict[str, Any]]:
    """Apply one source's decided verdicts to the bucket's issues.

    present + no issue      → opened
    present + resolved      → recurred
    present + active        → last seen / detail refreshed
    absent  + active        → resolved (by ``source``)
    undecided               → nothing (silence never resolves an issue)
    """
    details = details or {}
    changes: list[dict[str, Any]] = []
    now = utcnow()
    for code, verdict in verdicts.items():
        rule = rules.BY_CODE.get(code)
        if rule is None or verdict is None:
            continue
        fp = fingerprint(provider_id, bucket, code)
        row = conn.execute("SELECT id, status FROM issues WHERE fingerprint = ?", (fp,)).fetchone()
        detail = redact_text(details.get(code, ""))[:800] or None
        if verdict:
            if row is None:
                issue_id = uuid.uuid4().hex
                conn.execute(
                    "INSERT INTO issues (id, provider_id, bucket, code, fingerprint, title, severity, "
                    "status, detail_sanitized, first_seen_at, last_seen_at, source_task_id, "
                    "source_run_id, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)",
                    (issue_id, provider_id, bucket, code, fp, rules.title(rule), rule.severity,
                     detail, now, now, task_id, run_id, now, now))
                _event(conn, issue_id, "opened", source=source, detail={"run_id": run_id})
                changes.append({"issue_id": issue_id, "change": "opened"})
                continue
            conn.execute(
                "UPDATE issues SET last_seen_at = ?, detail_sanitized = COALESCE(?, detail_sanitized), "
                "source_task_id = COALESCE(?, source_task_id), source_run_id = COALESCE(?, source_run_id), "
                "updated_at = ? WHERE id = ?",
                (now, detail, task_id, run_id, now, row["id"]))
            if row["status"] == "resolved":
                _transition(conn, row["id"], "recurred", source=source, detail={"run_id": run_id})
                changes.append({"issue_id": row["id"], "change": "recurred"})
        elif row is not None and row["status"] in ACTIVE:
            _transition(conn, row["id"], "resolved", source=source, detail={"run_id": run_id})
            changes.append({"issue_id": row["id"], "change": "resolved"})
    return changes


# --- ingestion from completed runs ------------------------------------------------

def ingest_run(conn: sqlite3.Connection, run_id: str) -> list[dict[str, Any]]:
    """Project a completed survey or config review onto the estate. Returns the
    issue changes it caused. Never raises into the run (callers guard)."""
    run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if run is None or run["status"] != "completed" or not run["provider_id"]:
        return []
    if run["run_type"] == "account_discovery":
        changes = _ingest_survey(conn, run)
    elif run["run_type"] == "bucket_config_review":
        changes = _ingest_review(conn, run)
    else:
        return []
    conn.commit()
    return changes


def _ingest_survey(conn: sqlite3.Connection, run: sqlite3.Row) -> list[dict[str, Any]]:
    from ..repositories import account_discovery as account_repo
    profile = account_repo.get_profile(conn, run["id"])
    if profile is None:
        return []
    provider_id, task_id = run["provider_id"], run["session_id"]
    changes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for bucket in (profile.get("buckets") or [])[:_MAX_ESTATE_BUCKETS]:
        name = bucket.get("bucket_name")
        if not name:
            continue
        seen.add(name)
        upsert_bucket(conn, provider_id, name, region=bucket.get("region"), posture=bucket,
                      run_id=run["id"], task_id=task_id)
        changes += observe(conn, provider_id, name, rules.evaluate_posture(bucket),
                           source="survey", run_id=run["id"], task_id=task_id)
    # A bucket the account no longer lists is forgotten — but only when this
    # survey saw the whole account (not truncated, not narrowed by a pattern).
    options = _loads(run["options_json"], {}) or {}
    whole = (not profile.get("truncated") and profile.get("list_status") in (None, "available", "ok")
             and not options.get("include_pattern") and not options.get("exclude_pattern"))
    if whole:
        for row in conn.execute("SELECT bucket FROM estate_buckets WHERE provider_id = ?",
                                (provider_id,)).fetchall():
            if row["bucket"] not in seen:
                changes += _forget_bucket(conn, provider_id, row["bucket"], source="survey",
                                          run_id=run["id"])
    return changes


_REVIEW_TOOLS = {"review_bucket_security": "security", "review_bucket_lifecycle": "lifecycle"}


def _ingest_review(conn: sqlite3.Connection, run: sqlite3.Row) -> list[dict[str, Any]]:
    provider_id, bucket, task_id = run["provider_id"], run["bucket"], run["session_id"]
    if not bucket:
        return []
    verdicts: dict[str, rules.Verdict] = {}
    details: dict[str, str] = {}
    for tc in conn.execute("SELECT tool_name, output_json_sanitized FROM tool_calls "
                           "WHERE run_id = ? ORDER BY rowid", (run["id"],)).fetchall():
        check = _REVIEW_TOOLS.get(tc["tool_name"])
        if check is None:
            continue
        v, d = rules.evaluate_review(check, _loads(tc["output_json_sanitized"], {}))
        verdicts.update(v)
        details.update(d)
    upsert_bucket(conn, provider_id, bucket, run_id=run["id"], task_id=task_id)
    return observe(conn, provider_id, bucket, verdicts, details, source="review",
                   run_id=run["id"], task_id=task_id)


# --- reads --------------------------------------------------------------------------

def _issue_out(row: sqlite3.Row, lang: str = "en") -> dict[str, Any]:
    rule = rules.BY_CODE.get(row["code"])
    return {
        "id": row["id"],
        "provider_id": row["provider_id"],
        "bucket": row["bucket"],
        "code": row["code"],
        "title": rules.title(rule, lang) if rule else row["title"],
        "severity": row["severity"],
        "status": row["status"],
        "detail": row["detail_sanitized"],
        "first_seen_at": row["first_seen_at"],
        "last_seen_at": row["last_seen_at"],
        "resolved_at": row["resolved_at"],
        "resolved_by": row["resolved_by"],
        # A deleted task is not offered as a place to open.
        "source_task_id": row["live_task_id"],
        "fix": _loads(row["fix_json_sanitized"]),
        "fixable": rules.generate_fix(row["code"], row["bucket"]) is not None,
        "last_verified_at": row["last_verified_at"],
        "last_verify_result": row["last_verify_result"],
    }


# Issues of a deleted cloud provider are not shown (their rows stay until the
# estate is next pruned); a deleted task is not offered as a place to open.
_SELECT = ("SELECT i.*, CASE WHEN s.id IS NULL THEN NULL ELSE i.source_task_id END AS live_task_id "
           "FROM issues i JOIN cloud_providers cp ON cp.id = i.provider_id "
           "LEFT JOIN sessions s ON s.id = i.source_task_id")
_ORDER = ("ORDER BY CASE i.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 "
          "ELSE 3 END, i.last_seen_at DESC, i.id")


def list_issues(conn: sqlite3.Connection, *, status: str = "active", provider_id: str | None = None,
                limit: int = 200, lang: str = "en") -> list[dict[str, Any]]:
    where, args = [], []
    if status == "active":
        where.append(f"i.status IN ({','.join('?' * len(ACTIVE))})")
        args += list(ACTIVE)
    elif status != "all":
        where.append("i.status = ?")
        args.append(status)
    if provider_id:
        where.append("i.provider_id = ?")
        args.append(provider_id)
    sql = _SELECT + (" WHERE " + " AND ".join(where) if where else "")
    rows = conn.execute(f"{sql} {_ORDER} LIMIT ?",
                        (*args, max(1, min(_MAX_LIST, int(limit))))).fetchall()
    return [_issue_out(r, lang) for r in rows]


def get_issue(conn: sqlite3.Connection, issue_id: str, lang: str = "en") -> dict[str, Any] | None:
    row = conn.execute(_SELECT + " WHERE i.id = ?", (issue_id,)).fetchone()
    if row is None:
        return None
    out = _issue_out(row, lang)
    out["events"] = [
        {"kind": e["kind"], "source": e["source"], "at": e["created_at"],
         "detail": _loads(e["detail_json_sanitized"])}
        for e in conn.execute("SELECT * FROM issue_events WHERE issue_id = ? ORDER BY id DESC LIMIT 50",
                              (issue_id,)).fetchall()
    ]
    return out


def propose_fix(conn: sqlite3.Connection, issue_id: str) -> dict[str, Any] | None:
    """Generate (or return) the issue's fix; an active issue becomes
    ``fix_proposed``. Returns None when the rule has no generated fix."""
    row = conn.execute("SELECT * FROM issues WHERE id = ?", (issue_id,)).fetchone()
    if row is None:
        return None
    fix = rules.generate_fix(row["code"], row["bucket"])
    if fix is None:
        return None
    conn.execute("UPDATE issues SET fix_json_sanitized = ?, updated_at = ? WHERE id = ?",
                 (_dumps(fix), utcnow(), issue_id))
    if row["status"] in ("open", "recurred"):
        _transition(conn, issue_id, "fix_proposed", source="user", detail={"kind": fix["kind"]})
    conn.commit()
    return fix


def set_accepted(conn: sqlite3.Connection, issue_id: str, accepted: bool) -> bool:
    row = conn.execute("SELECT status FROM issues WHERE id = ?", (issue_id,)).fetchone()
    if row is None:
        return False
    if accepted and row["status"] in ("open", "fix_proposed", "recurred"):
        _transition(conn, issue_id, "accepted", source="user")
    elif not accepted and row["status"] == "accepted":
        _transition(conn, issue_id, "open", source="user", detail={"reopened": True})
    conn.commit()
    return True


def overview(conn: sqlite3.Connection, lang: str = "en") -> dict[str, Any]:
    """The estate at a glance: per provider its bucket count, last check, open
    issues by severity and watch state; plus the issues that need care now."""
    from ..repositories import cloud_providers as cloud_repo
    providers = []
    for p in cloud_repo.list_all(conn):
        b = conn.execute("SELECT COUNT(*) AS n, MAX(last_checked_at) AS at FROM estate_buckets "
                         "WHERE provider_id = ?", (p.id,)).fetchone()
        counts = {r["severity"]: r["n"] for r in conn.execute(
            "SELECT severity, COUNT(*) AS n FROM issues WHERE provider_id = ? AND status IN "
            "('open','fix_proposed','recurred') GROUP BY severity", (p.id,)).fetchall()}
        w = conn.execute("SELECT * FROM watch_schedules WHERE provider_id = ?", (p.id,)).fetchone()
        providers.append({
            "provider_id": p.id,
            "name": redact_text(p.name or ""),
            "provider_type": p.provider_type,
            "bucket_count": b["n"],
            "last_checked_at": b["at"],
            "open_issues": {s: counts.get(s, 0) for s in ("high", "medium", "low")},
            "watch": _watch_out(w),
        })
    care = [i for i in list_issues(conn, status="active", limit=50, lang=lang)
            if i["status"] != "accepted"]
    last_watch = conn.execute("SELECT MAX(last_run_at) AS at FROM watch_schedules").fetchone()["at"]
    return {
        "providers": providers,
        "bucket_count": sum(p["bucket_count"] for p in providers),
        "open_issue_count": len(care),
        "issues": care[:20],
        "last_watch_at": last_watch,
    }


def _watch_out(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {"enabled": False, "interval_hours": 24, "next_run_at": None, "last_run_at": None,
                "last_status": None, "last_summary": None, "last_task_id": None}
    return {"enabled": bool(row["enabled"]), "interval_hours": row["interval_hours"],
            "next_run_at": row["next_run_at"], "last_run_at": row["last_run_at"],
            "last_status": row["last_status"], "last_summary": row["last_summary_sanitized"],
            "last_task_id": row["last_task_id"]}


def prompt_block(conn: sqlite3.Connection) -> dict[str, Any] | None:
    """The bounded estate context the Agent starts every task with: per
    provider how many buckets are known and when they were last checked, and
    the open issues (most severe first, ≤ 12). No posture documents, no raw
    configuration."""
    rows = conn.execute("SELECT provider_id, COUNT(*) AS n, MAX(last_checked_at) AS at "
                        "FROM estate_buckets WHERE provider_id IN (SELECT id FROM cloud_providers) "
                        "GROUP BY provider_id").fetchall()
    issues = list_issues(conn, status="active", limit=12)
    if not rows and not issues:
        return None
    return {
        "note": ("What earlier work already established about the storage estate. Issues are "
                 "deterministic observations with a lifecycle; re-check before relying on an "
                 "old one, and never claim one is fixed without a read-only check."),
        "providers": [{"provider_id": r["provider_id"], "known_buckets": r["n"],
                       "last_checked_at": r["at"]} for r in rows],
        "open_issues": [{"bucket": i["bucket"], "provider_id": i["provider_id"], "code": i["code"],
                         "title": i["title"], "severity": i["severity"], "status": i["status"],
                         "last_seen_at": i["last_seen_at"]} for i in issues],
    }
