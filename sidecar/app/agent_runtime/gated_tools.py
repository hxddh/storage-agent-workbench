"""Gated tools — the Agent's data-moving capability, approved INSIDE the turn.

Codex-style: instead of the model *proposing* an import that the user then
runs through a separate dialog, the model CALLS ``import_evidence``. The tool
plans the bounded download (read-only listing), raises a first-class Decision
with the projected impact, and blocks until the user approves or declines —
the execution shows "Waiting for approval", the approval card sits inline in
the transcript. Approved → the same audited ``import_service`` path downloads
the confirmed files and the bounded result goes back to the model. Declined →
the model gets a structured refusal and answers from what it has.

Security floor (unchanged): the target must be a DISCOVERED evidence source;
bounds are clamped server-side; nothing downloads before the approval row is
``approved``; the tool's own output is app-generated (never raw rows).
"""

from __future__ import annotations

import sqlite3
import threading
import uuid
from collections.abc import Callable
from typing import Any

from ..security.redaction import redact_text
from ..sessions import next_actions

TOOL_NAME = "import_evidence"
ACTION_TYPES = {"inventory": "import_inventory", "access_log": "import_access_log"}
_MAX_RESULT = 1200


def _latest_account_run(conn: sqlite3.Connection, session_id: str) -> str | None:
    """The most recent account discovery run linked to this task (the model may
    omit account_run_id when the task surveyed the account already)."""
    row = conn.execute(
        "SELECT sr.run_id FROM session_runs sr JOIN runs r ON r.id = sr.run_id "
        "WHERE sr.session_id = ? AND r.run_type = 'account_discovery' "
        "AND r.status = 'completed' ORDER BY r.created_at DESC LIMIT 1",
        (session_id,)).fetchone()
    return row["run_id"] if row else None


def _impact(plan_row: dict[str, Any], source_type: str) -> dict[str, Any]:
    prefix = plan_row.get("source_prefix") or None
    return {
        "gate": "cloud_download",
        "why": ("Moves object bytes from the configured bucket onto this machine. "
                "Nothing downloads until you approve this bounded plan."),
        "bucket": redact_text(str(plan_row.get("source_bucket") or ""))[:200] or None,
        "prefix": redact_text(str(prefix))[:200] if prefix else None,
        "source_type": source_type,
        "file_count": int(plan_row.get("selected_file_count") or 0) or None,
        "total_bytes": int(plan_row.get("selected_total_bytes") or 0) or None,
        "scan_scope": next_actions._scan_scope_line(
            prefix, plan_row.get("max_files"), plan_row.get("max_bytes"),
            plan_row.get("time_range_start"), plan_row.get("time_range_end")),
        "warnings": [redact_text(str(w))[:200] for w in (plan_row.get("warnings") or [])[:5]],
    }


def build(conn: sqlite3.Connection, function_tool: Callable,
          activity: list[dict[str, Any]] | None, session_id: str | None,
          turn_id: str | None = None, cancel_event: Any = None) -> list[Any]:
    """The gated tool set bound to this execution. Empty without a task."""
    if conn is None or not session_id:
        return []
    from ..evidence import import_service
    from ..task_runtime import runtime, store

    _ids: dict[int, str] = {}

    def start(target: str) -> str:
        call_id = uuid.uuid4().hex
        _ids[threading.get_ident()] = call_id
        if activity is not None:
            activity.append({"id": call_id, "tool": TOOL_NAME, "target": target[:80],
                             "status": "started"})
        return call_id

    def note(target: str, result: str, ok: bool, decision_id: str | None = None) -> None:
        rec = {"id": _ids.pop(threading.get_ident(), uuid.uuid4().hex),
               "tool": TOOL_NAME, "target": target[:80], "result": result[:80],
               "ok": ok, "status": "completed"}
        if decision_id:
            rec["decision_id"] = decision_id
        if activity is not None:
            activity.append(rec)

    def _execution_id() -> str | None:
        if not turn_id:
            return None
        row = store.get_execution_by_turn(conn, session_id, turn_id)
        return row["id"] if row else None

    @function_tool
    def import_evidence(source_type: str, bucket_name: str, account_run_id: str | None = None,
                        time_range_start: str | None = None, time_range_end: str | None = None,
                        max_files: int | None = None, max_bytes: int | None = None) -> str:
        """Import a DISCOVERED evidence source (an S3 Inventory or server access logs) from the bucket onto this machine for deterministic analysis. This is the ONLY data-moving action: it plans a bounded download, then PAUSES this turn until the user approves the plan in the app. Approved → the files are downloaded, combined, and analyzed (use list_imported_evidence / aggregate_imported_evidence afterwards). Declined → you get a refusal; respect it and answer from what you have. Args: source_type ('inventory' | 'access_log'); bucket_name (the bucket whose evidence to import); account_run_id (the survey that discovered it — optional when this task already surveyed the account); time_range_start/time_range_end (ISO-8601, required for access_log); max_files / max_bytes (optional bounds, clamped server-side)."""
        src = (source_type or "").strip().lower()
        target = f"{src}:{bucket_name}"
        start(target)
        if src not in ACTION_TYPES:
            return note(target, "invalid source_type", False,
                        ) and "error: source_type must be 'inventory' or 'access_log'"
        run_id = (account_run_id or "").strip() or _latest_account_run(conn, session_id)
        if not run_id:
            note(target, "no account survey", False)
            return (
                "error: no account discovery run for this task yet — call survey_account "
                "first so the evidence source is discovered, then import it")
        exec_id = _execution_id()
        try:
            plan_row = import_service.plan(
                conn, account_run_id=run_id, bucket_name=bucket_name, source_type=src,
                max_files=max_files, max_bytes=max_bytes,
                time_range_start=time_range_start, time_range_end=time_range_end)
        except import_service.ImportServiceError as exc:
            note(target, "plan failed", False)
            return f"error: {exc.detail}"
        impact = _impact(plan_row, src)
        if not impact["file_count"]:
            note(target, "nothing to import", False)
            return (
                "status: nothing_to_import — the plan selected zero files "
                f"({'; '.join(impact['warnings']) or 'no matching objects'})")
        proposal = {
            "tool": TOOL_NAME, "import_id": plan_row["id"],
            "args": {"source_type": src, "bucket_name": redact_text(bucket_name)[:200],
                     "account_run_id": run_id,
                     **({"time_range_start": time_range_start,
                         "time_range_end": time_range_end} if src == "access_log" else {}),
                     "max_files": plan_row.get("max_files"), "max_bytes": plan_row.get("max_bytes")},
            "prefill": {"source_type": src, "bucket_name": redact_text(bucket_name)[:200],
                        "account_run_id": run_id, "prefix": impact["prefix"]},
            "impact": impact,
        }
        title = (f"Import {impact['file_count']} {src.replace('_', ' ')} file"
                 f"{'s' if impact['file_count'] != 1 else ''} from {impact['bucket']}")
        if exec_id is None:
            note(target, "no execution", False)
            return (
                "error: this call is not attached to a durable execution, so it cannot "
                "ask for approval — nothing was downloaded")
        decision = runtime.request_approval(
            conn, exec_id, session_id, action_type=ACTION_TYPES[src], title=title,
            reason=impact["why"], proposal=proposal, cancel_event=cancel_event)
        if decision["status"] != store.DECISION_APPROVED:
            note(target, "declined", False, decision["id"])
            return (
                "status: declined — the user did not approve this import. Do not retry it "
                "in this turn; answer from the evidence you already have and say what "
                "the import would have added.")
        try:
            import_service.confirm(conn, plan_row["id"], approved_by="user")
            out = import_service.run(conn, plan_row["id"], task_id=session_id)
        except import_service.ImportServiceError as exc:
            note(target, "import failed", False, decision["id"])
            return (
                f"error: approved, but the import failed — {exc.detail}")
        summary = (f"status: imported — {out['downloaded_file_count']} files, "
                   f"{out['downloaded_total_bytes']} bytes from {impact['bucket']}"
                   f"{' prefix ' + impact['prefix'] if impact['prefix'] else ''}. "
                   f"analysis_run_id={out['analysis_run_id']} (deterministic analysis "
                   "started in the background — read_run_result(run_id) for its findings; "
                   "list_imported_evidence / aggregate_imported_evidence to query the rows).")
        note(target, f"imported {out['downloaded_file_count']} files", True, decision["id"])
        return redact_text(summary)[:_MAX_RESULT]

    return [import_evidence]
