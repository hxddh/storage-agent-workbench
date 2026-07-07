"""Access-log analysis run executor."""

from __future__ import annotations

import sqlite3
from typing import Any

from .. import config
from ..analysis import access_logs
from ..events import bus
from ..repositories import datasets as datasets_repo
from ._common import RunError, require_success, run_executor, run_tool_with_events
from .analysis_report import render_access_log, write


def execute_access_log_run(conn: sqlite3.Connection, run_id: str) -> None:
    run_executor(conn, run_id, "Access-log analysis failed.",
                 lambda run: _body(conn, run_id, run))


def _body(conn: sqlite3.Connection, run_id: str, run: dict[str, Any]) -> str:
    ds = datasets_repo.latest_for_run(conn, run_id, "access_log")
    if ds is None or not ds.stored_path:
        raise RunError("No access_log dataset uploaded for this run.")

    raw_abs = config.data_dir() / ds.stored_path
    duckdb_abs = config.run_dir(run_id) / "analysis.duckdb"
    duckdb_rel = config.rel_path(duckdb_abs)
    raw_rel = ds.stored_path

    fmt = require_success(run_tool_with_events(
        conn, run_id, "detect_log_format", {"path": raw_rel},
        lambda: access_logs.detect_log_format(raw_abs),
    ))
    imp = require_success(run_tool_with_events(
        conn, run_id, "import_access_logs",
        {"path": raw_rel, "duckdb_path": duckdb_rel, "format": fmt.get("format")},
        lambda: access_logs.import_access_logs(raw_abs, duckdb_abs, fmt.get("format")),
    ))
    datasets_repo.mark_imported(conn, ds.id, duckdb_rel, imp["table_name"], imp["row_count"])

    metrics = require_success(run_tool_with_events(
        conn, run_id, "analyze_access_logs",
        # Honest descriptor of the deterministic analysis — NOT a SQL string.
        # The real DuckDB statements live in analysis/access_logs.py; recording
        # a fake "SELECT ..." here would misrepresent the audit trail (rule 17).
        {"duckdb_path": duckdb_rel,
         "analysis": "fixed access-log aggregate set (status/method/key/prefix/user-agent, hourly, error rates)"},
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
    if imp.get("truncated"):
        summary += (
            f" NOTE: the file exceeded the ingest cap ({imp.get('ingest_cap'):,} rows); "
            "metrics cover only the analyzed rows (a lower bound, not the whole file)."
        )
    bus.publish(run_id, {"type": "summary", "content": summary})

    ds_info = {"source_filename": ds.source_filename}
    require_success(run_tool_with_events(
        conn, run_id, "generate_markdown_report", {"run_id": run_id},
        lambda: {
            "report_path": config.rel_path(
                write(run_id, render_access_log(
                    run, ds_info, fmt.get("format"), metrics, findings, summary))
            ),
            "format": "markdown",
        },
    ))
    return summary
