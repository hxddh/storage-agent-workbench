"""Shared helpers for run executors.

``run_executor`` is the one harness every deterministic executor runs on: it
owns the status transitions (pending → running → completed/failed), the
reports-table row, the ``report_ready`` / ``error`` SSE events, and the
sanitized failure path. Executors provide only a body that does the actual
work and returns the final summary text.
"""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Callable
from typing import Any

from .. import config
from ..events import bus
from ..repositories import runs as runs_repo
from ..repositories import utcnow
from ..security.redaction import redact_text
from ..tool_runner import run_tool
from .report import report_path_for


def run_tool_with_events(
    conn: sqlite3.Connection,
    run_id: str,
    name: str,
    raw_input: dict[str, Any],
    executor: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    """Publish started/finished SSE events around a recorded tool call."""
    tool_call_id = uuid.uuid4().hex
    bus.publish(run_id, {"type": "tool_call_started", "tool_name": name, "tool_call_id": tool_call_id})
    out = run_tool(conn, name, raw_input, executor, run_id=run_id)
    status = "success" if out.get("success", True) else "error"
    bus.publish(run_id, {
        "type": "tool_call_finished",
        "tool_name": name,
        "tool_call_id": tool_call_id,
        "status": status,
        "output": out,
    })
    return out


class RunError(Exception):
    """Raised when a run cannot proceed (e.g. missing dataset)."""


def require_success(out: dict[str, Any]) -> dict[str, Any]:
    """Raise RunError when a recorded tool call reported failure."""
    if not out.get("success", True):
        raise RunError(out.get("error_message_sanitized") or "tool failed")
    return out


def _finalize_success(conn: sqlite3.Connection, run_id: str, summary: str) -> None:
    """Record the report row, mark the run completed, and announce the report.

    The reports table and ``runs.report_path`` store the path RELATIVE to the
    app data dir (never an absolute path that may embed a username); readers
    resolve it against ``config.data_dir()`` and still accept legacy absolute
    rows. created_at uses the repositories' ISO-8601 UTC "Z" format so report
    rows string-sort coherently with every other table.
    """
    report_rel = config.rel_path(report_path_for(run_id))
    conn.execute(
        "INSERT INTO reports (id, run_id, report_path, format, created_at) "
        "VALUES (?, ?, ?, 'markdown', ?)",
        (uuid.uuid4().hex, run_id, report_rel, utcnow()),
    )
    conn.commit()
    runs_repo.set_status(conn, run_id, "completed", final_summary=summary, report_path=report_rel)
    bus.publish(run_id, {"type": "report_ready", "run_id": run_id, "report_path": report_rel})


def run_executor(
    conn: sqlite3.Connection,
    run_id: str,
    failure_summary: str,
    body: Callable[[dict[str, Any]], str],
) -> None:
    """Shared executor harness (status/report/SSE/error scaffolding).

    ``body(run)`` performs the run's real work — tool calls, findings/summary
    events, and writing the report file to ``report_path_for(run_id)`` — and
    returns the final summary text. The harness then persists the report row
    and marks the run completed. Any exception (including RunError) marks the
    run failed with a sanitized message; a run that *ran* but found an
    unhealthy target must therefore NOT raise — 'failed' is reserved for the
    executor itself failing.
    """
    row = runs_repo.get_row(conn, run_id)
    if row is None:
        bus.publish(run_id, {"type": "error", "message": "run not found"})
        bus.mark_done(run_id)
        return
    run = dict(row)
    try:
        runs_repo.set_status(conn, run_id, "running")
        summary = body(run)
        _finalize_success(conn, run_id, summary)
    except Exception as exc:  # noqa: BLE001 - sanitized below
        detail = redact_text(str(exc)).strip()
        final = f"{failure_summary} {detail}".strip()[:500] if detail else failure_summary
        runs_repo.set_status(conn, run_id, "failed", final_summary=final)
        bus.publish(run_id, {"type": "error", "message": detail or failure_summary})
    finally:
        bus.mark_done(run_id)
