"""Proactive watch (v4.0) — a bounded, read-only sweep on the Sidecar's clock.

Opt-in per cloud provider and off by default. When a provider's watch is due,
the Sidecar (never a read, never the model) runs one sweep:

1. the account survey engine (read-only, hard-capped at 500 buckets), whose
   completion projects posture onto the estate like any other survey;
2. a read-only re-check of the buckets whose open issues the posture cannot
   decide (≤ 25 buckets per sweep);
3. when the sweep found something new (an issue opened or come back, high or
   medium), ONE Agent Task is opened with the evidence in its Direction and
   submitted through the one runtime path (``runtime.submit``) — so a watch
   costs model calls only when there is something to look at, and its work is
   an ordinary, stoppable Execution.

Turning a watch off stops a running sweep between phases: no re-checks and no
task follow. Nothing here writes to storage.
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from .. import config, db
from ..repositories import utcnow
from ..security.redaction import redact_text
from . import rules, store

logger = logging.getLogger(__name__)

MIN_HOURS = 1
MAX_HOURS = 24 * 7
SWEEP_MAX_BUCKETS = 500
RECHECK_MAX_BUCKETS = 25
KEEP_RUNS = 3
_ORIGIN = "watch"
_running: set[str] = set()
_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(at: datetime) -> str:
    return at.strftime("%Y-%m-%dT%H:%M:%SZ")


def get(conn: sqlite3.Connection, provider_id: str) -> dict[str, Any]:
    return store._watch_out(conn.execute(
        "SELECT * FROM watch_schedules WHERE provider_id = ?", (provider_id,)).fetchone())


def set_watch(conn: sqlite3.Connection, provider_id: str, *, enabled: bool,
              interval_hours: int) -> dict[str, Any]:
    """Turn a provider's watch on or off. Turning it on schedules the first
    sweep for the next tick, so the user sees it work; off clears the due
    time (and stops a running sweep between phases)."""
    hours = max(MIN_HOURS, min(MAX_HOURS, int(interval_hours)))
    now = utcnow()
    row = conn.execute("SELECT enabled, next_run_at FROM watch_schedules WHERE provider_id = ?",
                       (provider_id,)).fetchone()
    if enabled:
        was_on = bool(row and row["enabled"])
        next_run = row["next_run_at"] if was_on and row["next_run_at"] else now
    else:
        next_run = None
    conn.execute(
        "INSERT INTO watch_schedules (provider_id, enabled, interval_hours, next_run_at, "
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(provider_id) DO UPDATE SET enabled = excluded.enabled, "
        "interval_hours = excluded.interval_hours, next_run_at = excluded.next_run_at, "
        "updated_at = excluded.updated_at",
        (provider_id, 1 if enabled else 0, hours, next_run, now, now))
    conn.commit()
    return get(conn, provider_id)


def _still_enabled(conn: sqlite3.Connection, provider_id: str) -> bool:
    row = conn.execute("SELECT enabled FROM watch_schedules WHERE provider_id = ?",
                       (provider_id,)).fetchone()
    return bool(row and row["enabled"])


def due(conn: sqlite3.Connection) -> list[str]:
    return [r["provider_id"] for r in conn.execute(
        "SELECT w.provider_id FROM watch_schedules w JOIN cloud_providers cp ON cp.id = w.provider_id "
        "WHERE w.enabled = 1 AND w.next_run_at IS NOT NULL AND w.next_run_at <= ? "
        "ORDER BY w.next_run_at", (utcnow(),)).fetchall()]


def tick() -> int:
    """Run every due sweep (sequentially; one sweep per provider at a time).
    Returns how many ran. Called from the Sidecar lifespan loop."""
    conn = db.connect()
    try:
        ids = due(conn)
    finally:
        conn.close()
    ran = 0
    for provider_id in ids:
        if run_now(provider_id, wait=True, scheduled=True):
            ran += 1
    return ran


def run_now(provider_id: str, *, wait: bool = False, scheduled: bool = False) -> bool:
    """Start a sweep for ``provider_id`` unless one is already running.
    ``wait`` runs it on this thread (the scheduler); otherwise a daemon thread
    (the "Check now" action). Returns False when one was already running."""
    with _lock:
        if provider_id in _running:
            return False
        _running.add(provider_id)

    def _go() -> None:
        try:
            sweep(provider_id, scheduled=scheduled)
        except Exception:  # noqa: BLE001 — a failed sweep is recorded, never raised
            logger.exception("watch sweep failed")
        finally:
            with _lock:
                _running.discard(provider_id)

    if wait:
        _go()
    else:
        threading.Thread(target=_go, daemon=True).start()
    return True


def is_running(provider_id: str) -> bool:
    with _lock:
        return provider_id in _running


def _claim(conn: sqlite3.Connection, provider_id: str) -> None:
    row = conn.execute("SELECT interval_hours FROM watch_schedules WHERE provider_id = ?",
                       (provider_id,)).fetchone()
    hours = row["interval_hours"] if row else 24
    now = utcnow()
    conn.execute(
        "INSERT INTO watch_schedules (provider_id, enabled, interval_hours, created_at, updated_at) "
        "VALUES (?, 0, 24, ?, ?) ON CONFLICT(provider_id) DO NOTHING", (provider_id, now, now))
    conn.execute(
        "UPDATE watch_schedules SET last_status = 'running', "
        "next_run_at = CASE WHEN enabled = 1 THEN ? ELSE NULL END, updated_at = ? "
        "WHERE provider_id = ?",
        (_stamp(_now() + timedelta(hours=hours)), now, provider_id))
    conn.commit()


def _finish(conn: sqlite3.Connection, provider_id: str, *, status: str, summary: str,
            run_id: str | None, task_id: str | None) -> None:
    now = utcnow()
    conn.execute(
        "UPDATE watch_schedules SET last_run_at = ?, last_status = ?, last_summary_sanitized = ?, "
        "last_run_id = ?, last_task_id = COALESCE(?, last_task_id), updated_at = ? "
        "WHERE provider_id = ?",
        (now, status, redact_text(summary)[:600], run_id, task_id, now, provider_id))
    conn.commit()


def sweep(provider_id: str, *, scheduled: bool = False) -> dict[str, Any]:
    """One bounded, read-only sweep. Returns what it found. A ``scheduled``
    sweep stops between phases once its watch is turned off; one the user
    asked for ("Check now") runs to the end."""
    from ..models.schemas import RunCreate
    from ..repositories import cloud_providers as cloud_repo
    from ..repositories import runs as runs_repo
    from .. import run_service

    conn = db.connect()
    try:
        provider = cloud_repo.get(conn, provider_id)
        if provider is None:
            return {"status": "failed", "summary": "provider not found"}
        _claim(conn, provider_id)
        # Changes are this sweep's by event id (timestamps are per second).
        started = conn.execute("SELECT COALESCE(MAX(id), 0) FROM issue_events").fetchone()[0]
        run_id = runs_repo.create(conn, RunCreate(
            run_type="account_discovery", title="Watch sweep", provider_id=provider_id,
            max_buckets=SWEEP_MAX_BUCKETS), status="pending", origin=_ORIGIN)
        run_service.run_sync(run_id)  # completion projects posture onto the estate
        run = runs_repo.get_row(conn, run_id)
        if run is None or run["status"] != "completed":
            summary = "The survey did not complete: " + str((run["final_summary"] if run else "") or "")[:300]
            _finish(conn, provider_id, status="failed", summary=summary, run_id=run_id, task_id=None)
            return {"status": "failed", "summary": summary, "run_id": run_id}
        checked = conn.execute("SELECT COUNT(*) FROM estate_buckets WHERE provider_id = ? "
                               "AND source_run_id = ?", (provider_id, run_id)).fetchone()[0]

        def proceed() -> bool:
            return not scheduled or _still_enabled(conn, provider_id)

        if proceed():
            _recheck_undecided(conn, provider_id, proceed)

        changes = _changes_since(conn, provider_id, started)
        new = [c for c in changes if c["kind"] in ("opened", "recurred")
               and c["severity"] in ("high", "medium")]
        resolved = [c for c in changes if c["kind"] == "resolved"]
        summary = (f"Checked {checked} bucket(s): {len(new)} new or returned issue(s), "
                   f"{len(resolved)} resolved.")
        task_id = None
        if new and proceed():
            task_id, note = _open_task(conn, provider, new)
            if note:
                summary += " " + note
        _finish(conn, provider_id, status="found" if new else "clear", summary=summary,
                run_id=run_id, task_id=task_id)
        _prune_runs(conn, provider_id)
        return {"status": "found" if new else "clear", "summary": summary, "run_id": run_id,
                "task_id": task_id, "new": new, "resolved": resolved}
    except Exception as exc:  # noqa: BLE001
        try:
            _finish(conn, provider_id, status="failed",
                    summary=config.scrub_paths(redact_text(str(exc)))[:300], run_id=None, task_id=None)
        except Exception:  # noqa: BLE001
            pass
        raise
    finally:
        conn.close()


def _recheck_undecided(conn: sqlite3.Connection, provider_id: str, proceed) -> None:
    """Re-check (read-only) the buckets whose active issues the survey's
    posture cannot decide, bounded per sweep."""
    from . import verify
    by_bucket: dict[str, set[str]] = {}
    for row in conn.execute(
            "SELECT i.bucket, i.code, b.posture_json_sanitized FROM issues i "
            "LEFT JOIN estate_buckets b ON b.provider_id = i.provider_id AND b.bucket = i.bucket "
            "WHERE i.provider_id = ? AND i.status IN ('open','fix_proposed','recurred','accepted') "
            "ORDER BY CASE i.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, i.last_seen_at",
            (provider_id,)).fetchall():
        rule = rules.BY_CODE.get(row["code"])
        if rule is None:
            continue
        posture = store._loads(row["posture_json_sanitized"], {}) or {}
        if rule.code in rules.evaluate_posture(posture):
            continue  # the survey just decided it
        if row["bucket"] not in by_bucket and len(by_bucket) >= RECHECK_MAX_BUCKETS:
            continue
        by_bucket.setdefault(row["bucket"], set()).add(rule.check)
    for bucket, checks in by_bucket.items():
        if not proceed():
            break
        try:
            verify.recheck_bucket(conn, provider_id, bucket, checks, source="watch")
        except verify.VerifyError:
            continue


def _changes_since(conn: sqlite3.Connection, provider_id: str, since: int) -> list[dict[str, Any]]:
    return [dict(r) for r in conn.execute(
        "SELECT e.kind, e.source, i.id AS issue_id, i.bucket, i.code, i.title, i.severity, "
        "i.detail_sanitized AS detail FROM issue_events e JOIN issues i ON i.id = e.issue_id "
        "WHERE i.provider_id = ? AND e.id > ? AND e.kind IN ('opened','recurred','resolved') "
        "ORDER BY e.id", (provider_id, since)).fetchall()]


def direction_for(provider_name: str, new: list[dict[str, Any]]) -> str:
    lines = [f"- [{c['severity']}] {c['title']} — bucket `{c['bucket']}`"
             + (" (came back after being resolved)" if c["kind"] == "recurred" else "")
             + (f": {str(c['detail'])[:200]}" if c.get("detail") else "")
             for c in new[:12]]
    more = f"\n- …and {len(new) - 12} more" if len(new) > 12 else ""
    return (
        f"[watch] The scheduled read-only watch of the storage account \"{provider_name}\" found "
        f"{len(new)} new or returned issue(s):\n" + "\n".join(lines) + more + "\n\n"
        "Re-check each with read-only tools, explain the likely cause and the impact, and record "
        "a conclusion with the fix steps most severe first. Storage stays read-only: never change it."
    )


def _open_task(conn: sqlite3.Connection, provider: Any, new: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    """Open one Agent Task for what the sweep found and submit it through the
    one runtime path. Without a usable model the issues stay on the home and
    no task is opened."""
    from ..agent_runtime.agent_service import AgentUnavailable, get_model_credentials
    from ..models.schemas import SessionCreate
    from ..repositories import sessions as sessions_repo
    from ..task_runtime import runtime
    from ..task_runtime import store as task_store

    try:
        get_model_credentials(conn)
    except AgentUnavailable:
        return None, "No model is configured, so no task was opened."
    name = redact_text(provider.name or provider.id)
    title = f"Watch: {len(new)} new issue(s) on {name}"[:120]
    task_id = sessions_repo.create(conn, SessionCreate(title=title, goal=None, provider_id=provider.id))
    task_store.ensure_task(conn, task_id, title, None)
    conn.commit()
    try:
        runtime.submit(conn, task_id, direction_for(name, new), f"watch-{task_id[:12]}")
    except AgentUnavailable:
        return None, "The model could not be reached, so no task was started."
    now = utcnow()
    for c in new:
        conn.execute("UPDATE issues SET source_task_id = ?, updated_at = ? WHERE id = ?",
                     (task_id, now, c["issue_id"]))
    conn.commit()
    return task_id, None


def _prune_runs(conn: sqlite3.Connection, provider_id: str) -> None:
    """Keep the last few watch sweeps per provider (rows + on-disk dirs)."""
    from ..repositories import runs as runs_repo
    old = [r["id"] for r in conn.execute(
        "SELECT id FROM runs WHERE origin = ? AND provider_id = ? ORDER BY created_at DESC, rowid DESC "
        "LIMIT -1 OFFSET ?", (_ORIGIN, provider_id, KEEP_RUNS)).fetchall()]
    for rid in old:
        runs_repo.delete(conn, rid)
        shutil.rmtree(config.run_dir(rid), ignore_errors=True)
