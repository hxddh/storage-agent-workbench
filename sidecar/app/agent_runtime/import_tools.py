"""Evidence import — the Agent's one data-moving tool, bounded instead of gated.

v2.1 (native agent): the model CALLS ``import_evidence`` and the import runs
inside the same execution, with no approval pause. What used to be a human
checkpoint is now a hard server-side envelope the model cannot widen:

- the target must be an evidence source DISCOVERED by this task's account
  survey (never an arbitrary bucket/key);
- at most ``AGENT_MAX_FILES`` files and ``AGENT_MAX_BYTES`` bytes per call,
  whatever the model asks for;
- the data directory must keep ``_DISK_HEADROOM`` free after the download;
- every import is audited (``approval_events`` with ``approved_by=agent`` +
  ``audit_logs``) and shows as an ordinary tool row with the bytes it moved;
- Stop cancels the execution; the storage side stays read-only.

The tool's output is app-generated (never raw rows).
"""

from __future__ import annotations

import shutil
import sqlite3
import threading
import uuid
from collections.abc import Callable
from typing import Any

from .. import config, progress
from ..security.redaction import redact_text

TOOL_NAME = "import_evidence"
SOURCE_TYPES = ("inventory", "access_log")
_MAX_RESULT = 1200

# The autonomous envelope (v2.1). Well under managed_import's HARD_MAX_* so a
# model-driven import stays small, quick and cheap in egress.
AGENT_MAX_FILES = 500
AGENT_MAX_BYTES = 256 * 1024 * 1024
_DISK_HEADROOM = 1024 * 1024 * 1024  # keep 1 GiB free after the download


def _latest_account_run(conn: sqlite3.Connection, session_id: str) -> str | None:
    """The most recent account discovery run linked to this task (the model may
    omit account_run_id when the task surveyed the account already)."""
    row = conn.execute(
        "SELECT sr.run_id FROM session_runs sr JOIN runs r ON r.id = sr.run_id "
        "WHERE sr.session_id = ? AND r.run_type = 'account_discovery' "
        "AND r.status = 'completed' ORDER BY r.created_at DESC LIMIT 1",
        (session_id,)).fetchone()
    return row["run_id"] if row else None


def _clamp(value: int | None, ceiling: int) -> int:
    try:
        v = int(value) if value else ceiling
    except (TypeError, ValueError):
        v = ceiling
    return max(1, min(v, ceiling))


def _disk_ok(needed: int) -> bool:
    try:
        free = shutil.disk_usage(config.data_dir()).free
    except OSError:
        return True  # cannot tell — the import's own bounds still hold
    return free - int(needed) >= _DISK_HEADROOM


def build(conn: sqlite3.Connection, function_tool: Callable,
          activity: list[dict[str, Any]] | None, session_id: str | None,
          turn_id: str | None = None, cancel_event: Any = None) -> list[Any]:
    """The import tool bound to this execution. Empty without a task."""
    if conn is None or not session_id:
        return []
    from ..evidence import import_service

    _ids: dict[int, str] = {}

    def start(target: str) -> str:
        call_id = uuid.uuid4().hex
        _ids[threading.get_ident()] = call_id
        if activity is not None:
            activity.append({"id": call_id, "tool": TOOL_NAME, "target": target[:80],
                             "status": "started"})
        return call_id

    def note(target: str, result: str, ok: bool) -> None:
        if activity is not None:
            activity.append({"id": _ids.pop(threading.get_ident(), uuid.uuid4().hex),
                             "tool": TOOL_NAME, "target": target[:80], "result": result[:80],
                             "ok": ok, "status": "completed"})

    @function_tool
    def import_evidence(source_type: str, bucket_name: str, account_run_id: str | None = None,
                        time_range_start: str | None = None, time_range_end: str | None = None,
                        max_files: int | None = None, max_bytes: int | None = None) -> str:
        """Import a DISCOVERED evidence source (an S3 Inventory or server access logs) from the bucket onto this machine for deterministic analysis, then analyze it. This is the only data-moving action. It runs immediately, bounded server-side to at most 500 files / 256 MiB per call (larger requests are clamped; the result says when coverage is partial). Use list_imported_evidence / aggregate_imported_evidence afterwards. Args: source_type ('inventory' | 'access_log'); bucket_name (the bucket whose evidence to import); account_run_id (the survey that discovered it — optional when this task already surveyed the account); time_range_start/time_range_end (ISO-8601, required for access_log); max_files / max_bytes (optional, clamped)."""
        src = (source_type or "").strip().lower()
        target = f"{src}:{bucket_name}"
        call_id = start(target)
        if src not in SOURCE_TYPES:
            note(target, "invalid source_type", False)
            return "error: source_type must be 'inventory' or 'access_log'"
        if cancel_event is not None and cancel_event.is_set():
            note(target, "stopped", False)
            return "status: stopped — the execution was stopped before the import started"
        run_id = (account_run_id or "").strip() or _latest_account_run(conn, session_id)
        if not run_id:
            note(target, "no account survey", False)
            return (
                "error: no account discovery run for this task yet — call survey_account "
                "first so the evidence source is discovered, then import it")
        files_cap = _clamp(max_files, AGENT_MAX_FILES)
        bytes_cap = _clamp(max_bytes, AGENT_MAX_BYTES)
        try:
            plan_row = import_service.plan(
                conn, account_run_id=run_id, bucket_name=bucket_name, source_type=src,
                max_files=files_cap, max_bytes=bytes_cap,
                time_range_start=time_range_start, time_range_end=time_range_end)
        except import_service.ImportServiceError as exc:
            note(target, "plan failed", False)
            return f"error: {exc.detail}"
        files = int(plan_row.get("selected_file_count") or 0)
        size = int(plan_row.get("selected_total_bytes") or 0)
        warnings = [redact_text(str(w))[:200] for w in (plan_row.get("warnings") or [])[:5]]
        if not files:
            note(target, "nothing to import", False)
            return ("status: nothing_to_import — the plan selected zero files "
                    f"({'; '.join(warnings) or 'no matching objects'})")
        if not _disk_ok(size):
            note(target, "not enough disk space", False)
            return ("error: not enough free disk space in the data directory for this "
                    "import — nothing was downloaded. Narrow the time range or prefix.")
        try:
            import_service.confirm(conn, plan_row["id"], approved_by="agent")
            out = import_service.run(
                conn, plan_row["id"], task_id=session_id,
                on_file=progress.for_call(session_id, call_id, TOOL_NAME),
                cancel_event=cancel_event)
        except import_service.ImportServiceError as exc:
            if cancel_event is not None and cancel_event.is_set():
                note(target, "stopped", False)
                return ("status: stopped — the execution was stopped during the "
                        "download; nothing was kept")
            note(target, "import failed", False)
            return f"error: the import failed — {exc.detail}"
        bucket = redact_text(str(plan_row.get("source_bucket") or bucket_name))[:200]
        prefix = plan_row.get("source_prefix") or None
        partial = any("truncat" in w.lower() or "capped" in w.lower() for w in warnings)
        summary = (f"status: imported — {out['downloaded_file_count']} files, "
                   f"{out['downloaded_total_bytes']} bytes from {bucket}"
                   f"{' prefix ' + redact_text(str(prefix))[:200] if prefix else ''}"
                   f" (bounds: {files_cap} files / {bytes_cap} bytes"
                   f"{'; coverage is partial — say so' if partial else ''}). "
                   f"analysis_run_id={out['analysis_run_id']} (deterministic analysis "
                   "started in the background — read_run_result(run_id) for its findings; "
                   "list_imported_evidence / aggregate_imported_evidence to query the rows).")
        note(target, f"imported {out['downloaded_file_count']} files · {out['downloaded_total_bytes']} B", True)
        return redact_text(summary)[:_MAX_RESULT]

    return [import_evidence]
