"""Access-log analysis run executor (Phase 05)."""

from __future__ import annotations

import sqlite3
from typing import Any

from .. import config
from ..agent_runtime import analysis_agent
from ..agent_runtime.agent_service import AgentUnavailable, get_model_credentials
from ..analysis import access_logs
from ..events import bus
from ..repositories import datasets as datasets_repo
from ..repositories import runs as runs_repo
from ..security.redaction import redact_text
from ._common import RunError, run_tool_with_events
from .analysis_report import agent_analysis_md, render_access_log, write
from .report import report_path_for


def _require(out: dict[str, Any]) -> dict[str, Any]:
    if not out.get("success", True):
        raise RunError(out.get("error_message_sanitized") or "tool failed")
    return out


def execute_access_log_run(conn: sqlite3.Connection, run_id: str) -> None:
    row = runs_repo.get_row(conn, run_id)
    if row is None:
        bus.publish(run_id, {"type": "error", "message": "run not found"})
        bus.mark_done(run_id)
        return
    run = dict(row)
    agent_mode = run.get("planner_mode") == "agent"

    try:
        runs_repo.set_status(conn, run_id, "running")
        # In agent mode resolve model credentials FIRST so a missing key fails
        # cleanly before any analysis work; deterministic mode is unaffected.
        creds = None
        if agent_mode:
            creds = get_model_credentials(conn)  # raises AgentUnavailable if missing
            bus.publish(run_id, {"type": "run_started", "planner_mode": "agent"})

        ds = datasets_repo.latest_for_run(conn, run_id, "access_log")
        if ds is None or not ds.stored_path:
            raise RunError("No access_log dataset uploaded for this run.")

        raw_abs = config.data_dir() / ds.stored_path
        duckdb_abs = config.run_dir(run_id) / "analysis.duckdb"
        duckdb_rel = config.rel_path(duckdb_abs)
        raw_rel = ds.stored_path

        plan = [
            "Detect the access-log format (detect_log_format).",
            "Import and normalize the log into DuckDB (import_access_logs).",
            "Compute request, status, method, and concentration metrics (analyze_access_logs).",
            "Summarize evidence into findings.",
            "Generate a local Markdown report (generate_markdown_report).",
        ]
        bus.publish(run_id, {"type": "plan", "content": "\n".join(plan)})

        fmt = _require(run_tool_with_events(
            conn, run_id, "detect_log_format", {"path": raw_rel},
            lambda: access_logs.detect_log_format(raw_abs),
        ))
        imp = _require(run_tool_with_events(
            conn, run_id, "import_access_logs",
            {"path": raw_rel, "duckdb_path": duckdb_rel, "format": fmt.get("format")},
            lambda: access_logs.import_access_logs(raw_abs, duckdb_abs, fmt.get("format")),
        ))
        datasets_repo.mark_imported(conn, ds.id, duckdb_rel, imp["table_name"], imp["row_count"])

        metrics = _require(run_tool_with_events(
            conn, run_id, "analyze_access_logs",
            {"duckdb_path": duckdb_rel,
             "sql": "SELECT status_code/method/key/prefix/user_agent aggregates FROM access_logs"},
            lambda: access_logs.analyze_access_logs(duckdb_abs),
        ))

        findings = access_logs.derive_findings(metrics)
        for f in findings:
            bus.publish(run_id, {"type": "finding", **f})

        summary = (
            f"Analyzed {metrics.get('total_requests', 0)} request(s) from format "
            f"'{fmt.get('format')}'. 4xx={metrics.get('error_rate_4xx', 0):.1%}, "
            f"5xx={metrics.get('error_rate_5xx', 0):.1%}."
        )
        bus.publish(run_id, {"type": "summary", "content": summary})

        # Agent mode: interpret the deterministic aggregates only (no tools, no
        # raw data). The deterministic metrics/findings above stay authoritative.
        agent_section = ""
        if agent_mode:
            ds_meta = {
                "source_filename": ds.source_filename,
                "dataset_type": "access_log",
                "row_count": imp.get("row_count"),
                "detected_format": fmt.get("format"),
            }
            agent_result = analysis_agent.interpret(
                "access_log_analysis", run, ds_meta, metrics, findings, creds,
            )
            agent_section = agent_analysis_md("access_log_analysis", agent_result)
            if agent_result.get("executive_summary"):
                summary = agent_result["executive_summary"]
            bus.publish(run_id, {"type": "final_summary", "content": summary})

        ds_info = {"source_filename": ds.source_filename}
        _require(run_tool_with_events(
            conn, run_id, "generate_markdown_report", {"run_id": run_id},
            lambda: {
                "report_path": config.rel_path(
                    write(run_id, render_access_log(
                        run, ds_info, fmt.get("format"), metrics, findings, summary, agent_section))
                ),
                "format": "markdown",
            },
        ))

        report_abs = str(report_path_for(run_id))
        conn.execute(
            "INSERT INTO reports (id, run_id, report_path, format, created_at) "
            "VALUES (lower(hex(randomblob(16))), ?, ?, 'markdown', datetime('now'))",
            (run_id, report_abs),
        )
        conn.commit()
        runs_repo.set_status(conn, run_id, "completed", final_summary=summary, report_path=report_abs)
        bus.publish(run_id, {"type": "report_ready", "run_id": run_id, "report_path": config.rel_path(report_abs)})
    except AgentUnavailable as exc:
        runs_repo.set_status(conn, run_id, "failed", final_summary="Agent analysis unavailable.")
        bus.publish(run_id, {"type": "error", "message": redact_text(str(exc))})
    except Exception as exc:  # noqa: BLE001 - sanitized below
        runs_repo.set_status(conn, run_id, "failed", final_summary="Access-log analysis failed.")
        bus.publish(run_id, {"type": "error", "message": redact_text(str(exc))})
    finally:
        bus.mark_done(run_id)
