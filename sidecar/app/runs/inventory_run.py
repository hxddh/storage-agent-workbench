"""Inventory analysis run executor."""

from __future__ import annotations

import sqlite3
from typing import Any

from .. import config
from ..analysis import inventory
from ..events import bus
from ..repositories import datasets as datasets_repo
from ..repositories import runs as runs_repo
from ..security.redaction import redact_text
from ._common import RunError, run_tool_with_events
from .analysis_report import render_inventory, write
from .report import report_path_for


def _require(out: dict[str, Any]) -> dict[str, Any]:
    if not out.get("success", True):
        raise RunError(out.get("error_message_sanitized") or "tool failed")
    return out


def execute_inventory_run(conn: sqlite3.Connection, run_id: str) -> None:
    row = runs_repo.get_row(conn, run_id)
    if row is None:
        bus.publish(run_id, {"type": "error", "message": "run not found"})
        bus.mark_done(run_id)
        return
    run = dict(row)

    try:
        runs_repo.set_status(conn, run_id, "running")

        ds = datasets_repo.latest_for_run(conn, run_id, "inventory")
        if ds is None or not ds.stored_path:
            raise RunError("No inventory dataset uploaded for this run.")

        raw_abs = config.data_dir() / ds.stored_path
        duckdb_abs = config.run_dir(run_id) / "analysis.duckdb"
        duckdb_rel = config.rel_path(duckdb_abs)
        raw_rel = ds.stored_path

        imp = _require(run_tool_with_events(
            conn, run_id, "import_inventory_file",
            {"path": raw_rel, "duckdb_path": duckdb_rel},
            lambda: inventory.import_inventory_file(raw_abs, duckdb_abs),
        ))
        datasets_repo.mark_imported(conn, ds.id, duckdb_rel, imp["table_name"], imp["row_count"])

        metrics = _require(run_tool_with_events(
            conn, run_id, "analyze_inventory",
            {"duckdb_path": duckdb_rel,
             "sql": "SELECT size/age/prefix/storage_class aggregates FROM inventory_objects"},
            lambda: inventory.analyze_inventory(duckdb_abs),
        ))

        findings = inventory.derive_findings(metrics)
        for f in findings:
            bus.publish(run_id, {"type": "finding", **f})

        summary = (
            f"Analyzed {metrics.get('object_count', 0)} object(s), "
            f"total {metrics.get('total_size', 0)} bytes; small-object ratio "
            f"{metrics.get('small_object_ratio', 0):.1%}."
        )
        bus.publish(run_id, {"type": "summary", "content": summary})

        ds_info = {"source_filename": ds.source_filename}
        _require(run_tool_with_events(
            conn, run_id, "generate_markdown_report", {"run_id": run_id},
            lambda: {
                "report_path": config.rel_path(
                    write(run_id, render_inventory(run, ds_info, metrics, findings, summary))
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
    except Exception as exc:  # noqa: BLE001 - sanitized below
        runs_repo.set_status(conn, run_id, "failed", final_summary="Inventory analysis failed.")
        bus.publish(run_id, {"type": "error", "message": redact_text(str(exc))})
    finally:
        bus.mark_done(run_id)
