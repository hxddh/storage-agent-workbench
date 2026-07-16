"""Startup data maintenance — bounded reclamation for long-lived installs.

The app writes local artifacts (per-run directories) and append-only rows
(``audit_logs``, ad-hoc ``tool_calls``) that otherwise grow without bound over
months of daily use. This runs once at startup and is deliberately conservative:

- It only deletes the INTERNAL ('agent'-origin) runs of sessions that no longer
  exist — never a user-authored report run, never a run of a live session.
- It ages out the write-only audit trail past a generous retention window (a
  full year by default), satisfying "tool calls are recorded" while bounding
  growth. Set ``STORAGE_AGENT_AUDIT_RETENTION_DAYS=0`` to keep everything.

Everything here is best-effort: a failure to remove a directory or prune a row is
logged-by-return-count, never fatal to startup.
"""

from __future__ import annotations

import os
import shutil
from datetime import datetime, timedelta, timezone

from . import config
from .db import connect
from .repositories import runs as runs_repo

_DEFAULT_AUDIT_RETENTION_DAYS = 365


def _audit_retention_days() -> int:
    raw = os.environ.get("STORAGE_AGENT_AUDIT_RETENTION_DAYS")
    if raw is None:
        return _DEFAULT_AUDIT_RETENTION_DAYS
    try:
        return max(0, int(raw))
    except ValueError:
        return _DEFAULT_AUDIT_RETENTION_DAYS


def _remove_run_dirs(run_ids: list[str]) -> None:
    for rid in run_ids:
        shutil.rmtree(config.run_dir(rid), ignore_errors=True)


def sweep_orphaned_agent_runs(conn) -> int:
    """Delete 'agent'-origin runs whose session is gone (rows + on-disk dirs)."""
    ids = runs_repo.orphaned_agent_run_ids(conn)
    for rid in ids:
        runs_repo.delete(conn, rid)
    _remove_run_dirs(ids)
    return len(ids)


def prune_audit_logs(conn) -> int:
    """Age out audit rows and orphan-able ad-hoc tool_calls past the window.

    ``tool_calls`` with a ``run_id`` cascade when their run is deleted; the ones
    with ``run_id IS NULL`` (ad-hoc Test-Connection-style calls) never do, so they
    are pruned by age here too. Returns the number of audit rows removed."""
    days = _audit_retention_days()
    if days <= 0:
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    n = conn.execute("DELETE FROM audit_logs WHERE created_at < ?", (cutoff,)).rowcount
    conn.execute(
        "DELETE FROM tool_calls WHERE run_id IS NULL AND created_at < ?", (cutoff,)
    )
    conn.commit()
    return n


def run_startup_maintenance() -> dict[str, int]:
    """Run all maintenance passes. Best-effort; never raises into startup."""
    conn = connect()
    try:
        result = {
            "orphan_agent_runs_removed": sweep_orphaned_agent_runs(conn),
            "audit_rows_pruned": prune_audit_logs(conn),
        }
        return result
    except Exception:  # noqa: BLE001 - maintenance must never block startup
        return {"orphan_agent_runs_removed": 0, "audit_rows_pruned": 0}
    finally:
        conn.close()
