"""Inventory analysis run executor."""

from __future__ import annotations

import sqlite3
from typing import Any

from .. import config
from ..analysis import inventory
from ..events import bus
from ..repositories import datasets as datasets_repo
from ._common import RunError, require_success, run_executor, run_tool_with_events
from .analysis_report import render_inventory, write


def execute_inventory_run(conn: sqlite3.Connection, run_id: str) -> None:
    run_executor(conn, run_id, "Inventory analysis failed.",
                 lambda run: _body(conn, run_id, run))


def _body(conn: sqlite3.Connection, run_id: str, run: dict[str, Any]) -> str:
    ds = datasets_repo.latest_for_run(conn, run_id, "inventory")
    if ds is None or not ds.stored_path:
        raise RunError("No inventory dataset uploaded for this run.")

    raw_abs = config.data_dir() / ds.stored_path
    duckdb_abs = config.run_dir(run_id) / "analysis.duckdb"
    duckdb_rel = config.rel_path(duckdb_abs)
    raw_rel = ds.stored_path

    imp = require_success(run_tool_with_events(
        conn, run_id, "import_inventory_file",
        {"path": raw_rel, "duckdb_path": duckdb_rel},
        lambda: inventory.import_inventory_file(raw_abs, duckdb_abs),
    ))
    datasets_repo.mark_imported(conn, ds.id, duckdb_rel, imp["table_name"], imp["row_count"])

    metrics = require_success(run_tool_with_events(
        conn, run_id, "analyze_inventory",
        # Honest descriptor of the deterministic analysis — NOT a SQL string
        # (the real DuckDB statements live in analysis/inventory.py). Rule 17.
        {"duckdb_path": duckdb_rel,
         "analysis": "fixed inventory aggregate set (size/age/prefix/storage-class distributions, small-object ratio)"},
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
    if imp.get("truncated"):
        summary += (
            f" NOTE: the inventory exceeded the ingest cap ({imp.get('ingest_cap'):,} rows); "
            "metrics cover only the analyzed rows (a lower bound, not the whole object set)."
        )
    bus.publish(run_id, {"type": "summary", "content": summary})

    ds_info = {"source_filename": ds.source_filename}
    require_success(run_tool_with_events(
        conn, run_id, "generate_markdown_report", {"run_id": run_id},
        lambda: {
            "report_path": config.rel_path(
                write(run_id, render_inventory(run, ds_info, metrics, findings, summary))
            ),
            "format": "markdown",
        },
    ))
    return summary
