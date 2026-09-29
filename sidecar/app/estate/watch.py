"""Proactive watch (v5) — a bounded, read-only sweep on the Sidecar's clock.

Opt-in per storage account, off by default. A due sweep runs the survey engine
(≤ 500 buckets), re-checks what posture cannot decide (≤ 25 buckets), and only
when a high or medium issue opened or came back does it open ONE Agent Task
through the runtime, with the evidence in its Direction. No model configured →
no task (the issues stay on the home). A scheduled sweep stops between phases
once its watch is turned off. Nothing here writes to storage.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .. import db
from ..core import store as core_store
from ..core.clock import utcnow
from ..security.redaction import redact_text
from . import rules, store

logger = logging.getLogger(__name__)

MIN_HOURS = 1
MAX_HOURS = 24 * 7
SWEEP_MAX_BUCKETS = 500
RECHECK_MAX_BUCKETS = 25
KEEP_SURVEYS = 3
_running: set[str] = set()
_lock = threading.Lock()


def _stamp(at: datetime) -> str:
    return at.strftime("%Y-%m-%dT%H:%M:%SZ")


def get(conn: Any, provider_id: str) -> dict[str, Any]:
    return {**store.watch_out(conn.execute("SELECT * FROM watch_schedules WHERE provider_id = ?",
                                           (provider_id,)).fetchone()), "running": is_running(provider_id)}


def set_watch(conn: Any, provider_id: str, *, enabled: bool, interval_hours: int) -> dict[str, Any]:
    hours = max(MIN_HOURS, min(MAX_HOURS, int(interval_hours)))
    now = utcnow()
    row = conn.execute("SELECT enabled, next_run_at FROM watch_schedules WHERE provider_id = ?",
                       (provider_id,)).fetchone()
    if enabled:
        soonest = _stamp(datetime.now(timezone.utc) + timedelta(hours=hours))
        # A running schedule keeps its next run unless the new interval brings it closer.
        next_run = min(row["next_run_at"], soonest) if row and row["enabled"] and row["next_run_at"] else now
    else:
        next_run = None
    conn.execute(
        "INSERT INTO watch_schedules (provider_id, enabled, interval_hours, next_run_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET enabled = excluded.enabled, "
        "interval_hours = excluded.interval_hours, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at",
        (provider_id, 1 if enabled else 0, hours, next_run, now))
    core_store.audit(conn, actor="user", action="watch.set", target=provider_id,
                     detail={"enabled": enabled, "interval_hours": hours})
    conn.commit()
    return get(conn, provider_id)


def _enabled(conn: Any, provider_id: str) -> bool:
    row = conn.execute("SELECT enabled FROM watch_schedules WHERE provider_id = ?", (provider_id,)).fetchone()
    return bool(row and row["enabled"])


def due(conn: Any) -> list[str]:
    return [r["provider_id"] for r in conn.execute(
        "SELECT provider_id FROM watch_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL "
        "AND next_run_at <= ? ORDER BY next_run_at", (utcnow(),)).fetchall()]


def tick() -> int:
    conn = db.connect()
    try:
        ids = due(conn)
    finally:
        conn.close()
    return sum(1 for pid in ids if run_now(pid, wait=True, scheduled=True))


def run_now(provider_id: str, *, wait: bool = False, scheduled: bool = False) -> bool:
    with _lock:
        if provider_id in _running:
            return False
        _running.add(provider_id)

    def go() -> None:
        try:
            sweep(provider_id, scheduled=scheduled)
        except Exception:  # noqa: BLE001 — a failed sweep is recorded, never raised
            logger.exception("watch sweep failed")
        finally:
            with _lock:
                _running.discard(provider_id)

    if wait:
        go()
    else:
        threading.Thread(target=go, name=f"watch-{provider_id[:8]}", daemon=True).start()
    return True


def is_running(provider_id: str) -> bool:
    with _lock:
        return provider_id in _running


def _finish(conn: Any, provider_id: str, *, status: str, summary: str, task_id: str | None) -> None:
    now = utcnow()
    conn.execute("UPDATE watch_schedules SET last_run_at = ?, last_status = ?, last_summary = ?, "
                 "last_task_id = COALESCE(?, last_task_id), updated_at = ? WHERE provider_id = ?",
                 (now, status, redact_text(summary)[:600], task_id, now, provider_id))
    conn.commit()


def sweep(provider_id: str, *, scheduled: bool = False) -> dict[str, Any]:
    from ..engines import survey
    from ..providers import clouds

    conn = db.connect()
    try:
        cloud = clouds.get(conn, provider_id)
        if cloud is None:
            return {"status": "failed", "summary": "storage account not found"}
        row = conn.execute("SELECT interval_hours FROM watch_schedules WHERE provider_id = ?", (provider_id,)).fetchone()
        hours = row["interval_hours"] if row else 24
        now = utcnow()
        conn.execute("INSERT INTO watch_schedules (provider_id, enabled, interval_hours, updated_at) "
                     "VALUES (?, 0, 24, ?) ON CONFLICT(provider_id) DO NOTHING", (provider_id, now))
        conn.execute("UPDATE watch_schedules SET last_status = 'running', next_run_at = CASE WHEN enabled = 1 "
                     "THEN ? ELSE NULL END, updated_at = ? WHERE provider_id = ?",
                     (_stamp(datetime.now(timezone.utc) + timedelta(hours=hours)), now, provider_id))
        conn.commit()

        def proceed() -> bool:
            return not scheduled or _enabled(conn, provider_id)

        profile = survey.run(conn, provider_id, max_buckets=SWEEP_MAX_BUCKETS,
                             allowed_buckets=cloud.allowed_buckets, allowed_prefixes=cloud.allowed_prefixes,
                             cancelled=lambda: not proceed())
        if not profile.get("success"):
            summary = profile.get("summary_text") or "The survey failed."
            _finish(conn, provider_id, status="failed", summary=summary, task_id=None)
            return {"status": "failed", "summary": summary}
        core_store.add_artifact(conn, kind="survey", title=f"Watch survey · {cloud.name}", provider_id=provider_id,
                                payload=profile)
        _prune_surveys(conn, provider_id)
        changes = store.ingest_survey(conn, provider_id, profile, source="watch")
        if proceed():
            changes += _recheck_undecided(conn, provider_id, proceed)
        new = [c for c in changes if c["change"] in ("opened", "recurred") and c["severity"] in ("high", "medium")]
        resolved = [c for c in changes if c["change"] == "resolved"]
        summary = (f"Checked {profile.get('processed', 0)} bucket(s): {len(new)} new or returned issue(s), "
                   f"{len(resolved)} resolved.")
        task_id = None
        if new and proceed():
            task_id, note = _open_task(conn, cloud, new)
            if note:
                summary += " " + note
        _finish(conn, provider_id, status="found" if new else "clear", summary=summary, task_id=task_id)
        return {"status": "found" if new else "clear", "summary": summary, "task_id": task_id,
                "new": new, "resolved": resolved}
    except Exception as exc:  # noqa: BLE001
        try:
            _finish(conn, provider_id, status="failed", summary=redact_text(str(exc))[:300], task_id=None)
        except Exception:  # noqa: BLE001
            pass
        raise
    finally:
        conn.close()


def _recheck_undecided(conn: Any, provider_id: str, proceed: Callable[[], bool]) -> list[dict[str, Any]]:
    from . import verify
    by_bucket: dict[str, set[str]] = {}
    for row in conn.execute(
            "SELECT i.bucket, i.code, b.posture FROM issues i LEFT JOIN estate_buckets b "
            "ON b.provider_id = i.provider_id AND b.bucket = i.bucket WHERE i.provider_id = ? AND i.status IN "
            "('open','fix_proposed','recurred','accepted') ORDER BY CASE i.severity WHEN 'high' THEN 0 "
            "WHEN 'medium' THEN 1 ELSE 2 END, i.last_seen_at", (provider_id,)).fetchall():
        rule = rules.BY_CODE.get(row["code"])
        if rule is None or rule.code in rules.evaluate_posture(store.loads(row["posture"], {}) or {}):
            continue
        if row["bucket"] not in by_bucket and len(by_bucket) >= RECHECK_MAX_BUCKETS:
            continue
        by_bucket.setdefault(row["bucket"], set()).add(rule.check)
    changes: list[dict[str, Any]] = []
    for bucket, checks in by_bucket.items():
        if not proceed():
            break
        try:
            changes += verify.recheck_bucket(conn, provider_id, bucket, checks, source="watch", actor="watch")[1]
        except verify.VerifyError:
            continue
    return changes


def direction_for(name: str, new: list[dict[str, Any]]) -> str:
    lines = []
    for c in new[:12]:
        rule = rules.BY_CODE.get(c["code"])
        title = rules.title(rule) if rule else c["code"]
        lines.append(f"- [{c['severity']}] {title} — bucket `{c['bucket']}`"
                     + (" (came back after being resolved)" if c["change"] == "recurred" else ""))
    more = f"\n- …and {len(new) - 12} more" if len(new) > 12 else ""
    return (f"The scheduled read-only watch of the storage account \"{name}\" found {len(new)} new or returned "
            "issue(s):\n" + "\n".join(lines) + more + "\n\nRe-check each with read-only tools, explain the likely "
            "cause and impact, and record a conclusion with the fix steps, most severe first. Storage stays "
            "read-only: never change it.")


def _open_task(conn: Any, cloud: Any, new: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    from ..agent.runtime import RUNTIME
    from ..providers import models as model_providers
    try:
        model_providers.credentials(conn)
    except model_providers.AgentUnavailable:
        return None, "No model is configured, so no task was opened."
    name = redact_text(cloud.name or cloud.id)
    task = core_store.create_task(conn, f"Watch: {len(new)} new issue(s) on {name}"[:120], origin="watch")
    RUNTIME.submit(conn, task["id"], direction_for(name, new), kind="watch")
    now = utcnow()
    for c in new:
        conn.execute("UPDATE issues SET source_task_id = ?, updated_at = ? WHERE id = ?", (task["id"], now, c["issue_id"]))
    conn.commit()
    return task["id"], None


def _prune_surveys(conn: Any, provider_id: str) -> None:
    conn.execute("DELETE FROM artifacts WHERE id IN (SELECT id FROM artifacts WHERE kind = 'survey' AND task_id IS NULL "
                 "AND provider_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?)", (provider_id, KEEP_SURVEYS))
    conn.commit()
