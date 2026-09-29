"""The storage estate (v5): buckets, issues and their lifecycle.

The survey and review tools call ``ingest_survey`` / ``ingest_review`` with
their deterministic output. Issues are opened, resolved and marked recurred
only by those observations (``rules.py``) — never by model prose — and a read
that could not see something decides nothing.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from ..core.clock import utcnow
from ..security.redaction import redact_text
from . import rules

ACTIVE = ("open", "fix_proposed", "recurred", "accepted")
CARE = ("open", "fix_proposed", "recurred")
STATUSES = ("open", "fix_proposed", "resolved", "recurred", "accepted")
_MAX_BUCKETS = 5000


def _dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), default=str, ensure_ascii=False)


def loads(raw: str | None, default: Any = None) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


def fingerprint(provider_id: str, bucket: str, code: str) -> str:
    return f"{provider_id}:{bucket}:{code}"


# --- buckets ------------------------------------------------------------------------

def upsert_bucket(conn: sqlite3.Connection, provider_id: str, bucket: str, *, region: str | None = None,
                  posture: dict[str, Any] | None = None, task_id: str | None = None) -> None:
    task_id = task_id or None  # a call outside a task (the MCP bridge) never unlinks the one that found it
    existing = conn.execute("SELECT posture, region FROM estate_buckets WHERE provider_id = ? AND bucket = ?",
                            (provider_id, bucket)).fetchone()
    posture_json = _dumps(rules.posture_projection(posture)) if posture is not None else (
        existing["posture"] if existing else None)
    conn.execute(
        "INSERT INTO estate_buckets (provider_id, bucket, region, posture, last_checked_at, source_task_id) "
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider_id, bucket) DO UPDATE SET "
        "region = COALESCE(excluded.region, estate_buckets.region), posture = excluded.posture, "
        "last_checked_at = excluded.last_checked_at, "
        "source_task_id = COALESCE(excluded.source_task_id, estate_buckets.source_task_id)",
        (provider_id, bucket, region or (existing["region"] if existing else None), posture_json, utcnow(), task_id))


def _forget_bucket(conn: sqlite3.Connection, provider_id: str, bucket: str, *, source: str) -> list[dict[str, Any]]:
    changes = []
    for row in conn.execute(f"SELECT id FROM issues WHERE provider_id = ? AND bucket = ? AND status IN "
                            f"({','.join('?' * len(ACTIVE))})", (provider_id, bucket, *ACTIVE)).fetchall():
        _transition(conn, row["id"], "resolved", source=source, detail={"reason": "bucket_no_longer_listed"})
        changes.append({"issue_id": row["id"], "change": "resolved"})
    conn.execute("DELETE FROM estate_buckets WHERE provider_id = ? AND bucket = ?", (provider_id, bucket))
    return changes


# --- issue lifecycle ------------------------------------------------------------------

def event(conn: sqlite3.Connection, issue_id: str, kind: str, *, source: str | None,
          detail: dict[str, Any] | None = None) -> None:
    conn.execute("INSERT INTO issue_events (issue_id, kind, source, detail, created_at) VALUES (?, ?, ?, ?, ?)",
                 (issue_id, kind, source, _dumps(detail) if detail else None, utcnow()))


def _transition(conn: sqlite3.Connection, issue_id: str, status: str, *, source: str,
                detail: dict[str, Any] | None = None) -> None:
    now = utcnow()
    if status == "resolved":
        conn.execute("UPDATE issues SET status = 'resolved', resolved_at = ?, resolved_by = ?, updated_at = ? "
                     "WHERE id = ?", (now, source, now, issue_id))
    else:
        conn.execute("UPDATE issues SET status = ?, resolved_at = NULL, resolved_by = NULL, updated_at = ? "
                     "WHERE id = ?", (status, now, issue_id))
    event(conn, issue_id, status, source=source, detail=detail)


def observe(conn: sqlite3.Connection, provider_id: str, bucket: str, verdicts: dict[str, rules.Verdict],
            details: dict[str, str] | None = None, *, source: str,
            task_id: str | None = None) -> list[dict[str, Any]]:
    """Apply one source's decided verdicts. present+none → opened; present+resolved
    → recurred; present+active → seen; absent+active → resolved; undecided → nothing."""
    details = details or {}
    task_id = task_id or None
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
                iid = uuid.uuid4().hex
                conn.execute(
                    "INSERT INTO issues (id, provider_id, bucket, code, fingerprint, severity, status, detail, "
                    "first_seen_at, last_seen_at, source_task_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)",
                    (iid, provider_id, bucket, code, fp, rule.severity, detail, now, now, task_id, now))
                event(conn, iid, "opened", source=source)
                changes.append({"issue_id": iid, "change": "opened", "code": code, "bucket": bucket,
                                "severity": rule.severity})
                continue
            conn.execute("UPDATE issues SET last_seen_at = ?, detail = COALESCE(?, detail), "
                         "source_task_id = COALESCE(?, source_task_id), updated_at = ? WHERE id = ?",
                         (now, detail, task_id, now, row["id"]))
            if row["status"] == "resolved":
                _transition(conn, row["id"], "recurred", source=source)
                changes.append({"issue_id": row["id"], "change": "recurred", "code": code, "bucket": bucket,
                                "severity": rule.severity})
        elif row is not None and row["status"] in ACTIVE:
            _transition(conn, row["id"], "resolved", source=source)
            changes.append({"issue_id": row["id"], "change": "resolved", "code": code, "bucket": bucket,
                            "severity": rule.severity})
    return changes


def ingest_survey(conn: sqlite3.Connection, provider_id: str, profile: dict[str, Any], *,
                  task_id: str | None = None, source: str = "survey") -> list[dict[str, Any]]:
    """Project a survey profile onto the estate. A survey that saw the whole
    account (not truncated, not scoped, not narrowed) forgets buckets no longer listed."""
    changes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for bucket in (profile.get("buckets") or [])[:_MAX_BUCKETS]:
        name = bucket.get("bucket_name")
        if not name:
            continue
        seen.add(name)
        upsert_bucket(conn, provider_id, name, region=bucket.get("region"), posture=bucket, task_id=task_id)
        changes += observe(conn, provider_id, name, rules.evaluate_posture(bucket), source=source, task_id=task_id)
    if profile.get("whole_account"):
        for row in conn.execute("SELECT bucket FROM estate_buckets WHERE provider_id = ?", (provider_id,)).fetchall():
            if row["bucket"] not in seen:
                changes += _forget_bucket(conn, provider_id, row["bucket"], source=source)
    conn.commit()
    return changes


def ingest_review(conn: sqlite3.Connection, provider_id: str, bucket: str, outputs: dict[str, Any], *,
                  task_id: str | None = None, source: str = "review") -> list[dict[str, Any]]:
    """Project security / lifecycle review outputs ({check: output}) onto the estate."""
    verdicts: dict[str, rules.Verdict] = {}
    details: dict[str, str] = {}
    for check, out in outputs.items():
        v, d = rules.evaluate_review(check, out)
        verdicts.update(v)
        details.update(d)
    upsert_bucket(conn, provider_id, bucket, task_id=task_id)
    changes = observe(conn, provider_id, bucket, verdicts, details, source=source, task_id=task_id)
    conn.commit()
    return changes


# --- reads ------------------------------------------------------------------------------

_SELECT = ("SELECT i.*, CASE WHEN t.id IS NULL THEN NULL ELSE i.source_task_id END AS live_task_id, "
           "cp.name AS provider_name, cp.endpoint_url AS endpoint_url, cp.region AS provider_region "
           "FROM issues i JOIN cloud_providers cp ON cp.id = i.provider_id "
           "LEFT JOIN tasks t ON t.id = i.source_task_id")
_ORDER = ("ORDER BY CASE i.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, "
          "i.last_seen_at DESC, i.id")


def _issue_out(row: sqlite3.Row, lang: str = "en") -> dict[str, Any]:
    rule = rules.BY_CODE.get(row["code"])
    return {
        "id": row["id"], "provider_id": row["provider_id"], "provider_name": row["provider_name"],
        "bucket": row["bucket"], "code": row["code"],
        "title": rules.title(rule, lang) if rule else row["code"],
        "severity": row["severity"], "status": row["status"], "detail": row["detail"],
        "first_seen_at": row["first_seen_at"], "last_seen_at": row["last_seen_at"],
        "resolved_at": row["resolved_at"], "resolved_by": row["resolved_by"],
        "source_task_id": row["live_task_id"], "fix": loads(row["fix"]),
        "fixable": rules.generate_fix(row["code"], row["bucket"]) is not None,
        "last_verified_at": row["last_verified_at"], "last_verify_result": row["last_verify_result"],
    }


def _status_filter(status: str) -> tuple[list[str], list[Any]]:
    if status in ("active", "care"):
        group = ACTIVE if status == "active" else CARE
        return [f"i.status IN ({','.join('?' * len(group))})"], list(group)
    if status != "all":
        return ["i.status = ?"], [status]
    return [], []


def count_issues(conn: sqlite3.Connection, *, status: str = "care") -> int:
    where, args = _status_filter(status)
    sql = "SELECT COUNT(*) FROM issues i JOIN cloud_providers cp ON cp.id = i.provider_id"
    return conn.execute(sql + (" WHERE " + " AND ".join(where) if where else ""), args).fetchone()[0]


def list_issues(conn: sqlite3.Connection, *, status: str = "active", provider_id: str | None = None,
                bucket: str | None = None, limit: int = 200, lang: str = "en") -> list[dict[str, Any]]:
    where, args = _status_filter(status)
    if provider_id:
        where.append("i.provider_id = ?")
        args.append(provider_id)
    if bucket:
        where.append("i.bucket = ?")
        args.append(bucket)
    sql = _SELECT + (" WHERE " + " AND ".join(where) if where else "")
    rows = conn.execute(f"{sql} {_ORDER} LIMIT ?", (*args, max(1, min(500, int(limit))))).fetchall()
    return [_issue_out(r, lang) for r in rows]


def get_issue(conn: sqlite3.Connection, issue_id: str, lang: str = "en") -> dict[str, Any] | None:
    row = conn.execute(_SELECT + " WHERE i.id = ?", (issue_id,)).fetchone()
    if row is None:
        return None
    out = _issue_out(row, lang)
    out["events"] = [{"kind": e["kind"], "source": e["source"], "at": e["created_at"], "detail": loads(e["detail"])}
                     for e in conn.execute("SELECT * FROM issue_events WHERE issue_id = ? ORDER BY id DESC LIMIT 50",
                                           (issue_id,)).fetchall()]
    return out


def propose_fix(conn: sqlite3.Connection, issue_id: str) -> dict[str, Any] | None:
    row = conn.execute(_SELECT + " WHERE i.id = ?", (issue_id,)).fetchone()
    if row is None:
        return None
    fix = rules.generate_fix(row["code"], row["bucket"], endpoint_url=row["endpoint_url"] or None,
                             region=row["provider_region"] or None)
    if fix is None:
        return None
    conn.execute("UPDATE issues SET fix = ?, updated_at = ? WHERE id = ?", (_dumps(fix), utcnow(), issue_id))
    if row["status"] in ("open", "recurred"):
        _transition(conn, issue_id, "fix_proposed", source="user", detail={"kind": fix["kind"]})
    conn.commit()
    return fix


def set_accepted(conn: sqlite3.Connection, issue_id: str, accepted: bool) -> bool:
    row = conn.execute("SELECT status FROM issues WHERE id = ?", (issue_id,)).fetchone()
    if row is None:
        return False
    if accepted and row["status"] in CARE:
        _transition(conn, issue_id, "accepted", source="user")
    elif not accepted and row["status"] == "accepted":
        _transition(conn, issue_id, "open", source="user", detail={"reopened": True})
    conn.commit()
    return True


def watch_out(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {"enabled": False, "interval_hours": 24, "next_run_at": None, "last_run_at": None,
                "last_status": None, "last_summary": None, "last_task_id": None}
    return {"enabled": bool(row["enabled"]), "interval_hours": row["interval_hours"],
            "next_run_at": row["next_run_at"], "last_run_at": row["last_run_at"],
            "last_status": row["last_status"], "last_summary": row["last_summary"],
            "last_task_id": row["last_task_id"]}


def overview(conn: sqlite3.Connection, lang: str = "en") -> dict[str, Any]:
    """The estate at a glance — what the home shows."""
    from ..providers import clouds
    from . import watch
    providers = []
    for c in clouds.list_all(conn):
        b = conn.execute("SELECT COUNT(*) AS n, MAX(last_checked_at) AS at FROM estate_buckets WHERE provider_id = ?",
                         (c.id,)).fetchone()
        counts = {r["severity"]: r["n"] for r in conn.execute(
            "SELECT severity, COUNT(*) AS n FROM issues WHERE provider_id = ? AND status IN "
            "('open','fix_proposed','recurred') GROUP BY severity", (c.id,)).fetchall()}
        w = conn.execute("SELECT * FROM watch_schedules WHERE provider_id = ?", (c.id,)).fetchone()
        providers.append({"provider_id": c.id, "name": redact_text(c.name), "provider_type": c.provider_type,
                          "bucket_count": b["n"], "last_checked_at": b["at"],
                          "open_issues": {s: counts.get(s, 0) for s in ("high", "medium", "low")},
                          "watch": {**watch_out(w), "running": watch.is_running(c.id)}})
    last_watch = conn.execute("SELECT MAX(last_run_at) AS at FROM watch_schedules").fetchone()["at"]
    return {"providers": providers, "bucket_count": sum(p["bucket_count"] for p in providers),
            "open_issue_count": count_issues(conn, status="care"),
            "issues": list_issues(conn, status="care", limit=20, lang=lang),
            "last_watch_at": last_watch}


def buckets(conn: sqlite3.Connection, provider_id: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
    sql = "SELECT * FROM estate_buckets" + (" WHERE provider_id = ?" if provider_id else "") + \
          " ORDER BY provider_id, bucket LIMIT ?"
    args: tuple[Any, ...] = (provider_id, limit) if provider_id else (limit,)
    return [{"provider_id": r["provider_id"], "bucket": r["bucket"], "region": r["region"],
             "posture": loads(r["posture"], {}), "last_checked_at": r["last_checked_at"]}
            for r in conn.execute(sql, args).fetchall()]


def digest(conn: sqlite3.Connection) -> dict[str, Any] | None:
    """What every turn starts knowing: known buckets per provider and the open
    issues (≤ 12). No posture documents; the query_estate tool has the rest."""
    rows = conn.execute("SELECT provider_id, COUNT(*) AS n, MAX(last_checked_at) AS at FROM estate_buckets "
                        "WHERE provider_id IN (SELECT id FROM cloud_providers) GROUP BY provider_id").fetchall()
    issues = list_issues(conn, status="care", limit=12)
    if not rows and not issues:
        return None
    return {"providers": [{"provider_id": r["provider_id"], "known_buckets": r["n"], "last_checked_at": r["at"]}
                          for r in rows],
            "open_issues": [{"bucket": i["bucket"], "provider_id": i["provider_id"], "code": i["code"],
                             "title": i["title"], "severity": i["severity"], "status": i["status"],
                             "last_seen_at": i["last_seen_at"]} for i in issues]}
