"""Read-only analysis tools the in-chat agent uses on user-uploaded files.

These close the last big ossification gap: a file the user attaches in the
conversation used to force a fixed deterministic analysis run (canned 5-step
plan, no interpretation). Instead, the conversational agent now *discovers* and
*analyzes* the upload as a tool and answers inline — true agent behavior.

The heavy compute stays deterministic and reproducible (the same DuckDB engine
the analysis runs use): detect → import → analyze. But it is INVOKED by the
agent, and the agent narrates the result in its own words. Security is unchanged
and enforced below this layer:
- the file is a LOCAL upload (no cloud download);
- only SANITIZED aggregates are returned (distributions, rates, ≤20 sample
  keys) — never raw rows, full key lists, or object bodies;
- read-only: nothing is mutated; no new capability is exposed.

Always available to the session agent regardless of autonomy policy — analyzing
a local file the user explicitly handed over is safe-by-construction and not
data-moving.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Callable

from .. import audit, config
from ..analysis import access_logs, inventory
from ..repositories import session_datasets as ds_repo
from ..security.redaction import redact_text

# Bound what we hand back to the model (the aggregates are already small, but
# clamp defensively so a pathological dataset can't bloat the prompt).
_MAX_DIST = 15
_MAX_KEYS = 20


def _err(msg: str) -> str:
    return json.dumps({"error": redact_text(str(msg))[:300]})


def _clamp_lists(metrics: dict[str, Any]) -> dict[str, Any]:
    """Trim distribution/sample lists so the returned aggregates stay compact."""
    out = dict(metrics)
    for k, v in list(out.items()):
        if isinstance(v, list):
            cap = _MAX_KEYS if ("key" in k or "prefix" in k) else _MAX_DIST
            out[k] = v[:cap]
    return out


def build(
    conn: sqlite3.Connection,
    function_tool: Callable,
    session_id: str | None,
    activity: list[dict[str, Any]] | None = None,
) -> list[Any]:
    """Build the uploaded-file analysis tools for the session agent.

    Empty when there is no session (the tools are session-scoped).
    """
    if conn is None or not session_id:
        return []

    def note(tool: str, target: str, result: str) -> None:
        if activity is not None:
            activity.append({"tool": tool, "target": target[:80], "result": result[:80]})

    @function_tool
    def list_uploaded_files() -> str:
        """List the data files the user has uploaded in this session (access logs, inventory exports). Returns each file's id, filename, type, and whether it has been analyzed yet. Call this when the user refers to a file they attached ("分析下", "this log", "the file I uploaded"). Args: none."""
        rows = ds_repo.list_for_session(conn, session_id)
        items = [
            {
                "dataset_id": r["id"],
                "filename": r["source_filename"],
                "type": r["dataset_type"],
                "status": r["status"],
                "row_count": r["row_count"],
                "detected_format": r["detected_format"],
            }
            for r in rows
        ]
        note("list_uploaded_files", session_id or "", f"{len(items)} file(s)")
        return json.dumps({"files": items})

    @function_tool
    def analyze_uploaded_file(dataset_id: str) -> str:
        """Analyze one uploaded file (access log or inventory export) locally with DuckDB and return SANITIZED aggregates: for access logs — total requests, status/method distributions, 4xx/5xx rates, top keys/prefixes/user-agents, requests-by-hour, plus rule-based findings; for inventory — object count, total/avg size, storage-class and prefix distributions, small-object ratio. Use the result to answer the user in your own words; if the data is not actually a recognized access log or inventory (e.g. a generic application log with no HTTP fields), say so plainly and describe what the file does contain rather than reporting meaningless zeros. Very large files are analyzed up to a row cap: when the result has "truncated": true, the metrics cover only the first rows_analyzed rows — report them as a lower bound, not the whole file. Args: dataset_id (from list_uploaded_files)."""
        ds = ds_repo.get(conn, dataset_id)
        if ds is None or ds.get("session_id") != session_id:
            return _err("Unknown dataset_id for this session. Call list_uploaded_files first.")
        if not ds.get("stored_path"):
            return _err("That upload has no stored file.")

        raw_abs = config.data_dir() / ds["stored_path"]
        if not raw_abs.exists():
            return _err("The uploaded file is no longer available on disk.")

        duckdb_abs = config.data_dir() / "sessions" / session_id / f"{dataset_id}.duckdb"
        duckdb_abs.parent.mkdir(parents=True, exist_ok=True)
        duckdb_rel = config.rel_path(duckdb_abs)

        try:
            if ds["dataset_type"] == "access_log":
                fmt = access_logs.detect_log_format(raw_abs)
                imp = access_logs.import_access_logs(raw_abs, duckdb_abs, fmt.get("format"))
                metrics = access_logs.analyze_access_logs(duckdb_abs)
                findings = access_logs.derive_findings(metrics)
                detected = fmt.get("format")
                result: dict[str, Any] = {
                    "dataset_id": dataset_id,
                    "filename": ds["source_filename"],
                    "type": "access_log",
                    "detected_format": detected,
                    "row_count": imp.get("row_count"),
                    "metrics": _clamp_lists(metrics),
                    "findings": findings[:_MAX_DIST],
                }
                if detected == "unknown":
                    result["note"] = (
                        "The log format was NOT recognized as an access log (no parseable "
                        "HTTP method/status/path fields). The rows were ingested as raw text, "
                        "so request/status metrics will be empty or zero. Tell the user this is "
                        "not a standard access log and describe what the lines actually look like "
                        "instead of reporting the empty HTTP metrics as if they were real."
                    )
            elif ds["dataset_type"] == "inventory":
                imp = inventory.import_inventory_file(raw_abs, duckdb_abs)
                metrics = inventory.analyze_inventory(duckdb_abs)
                findings = inventory.derive_findings(metrics)
                result = {
                    "dataset_id": dataset_id,
                    "filename": ds["source_filename"],
                    "type": "inventory",
                    "row_count": imp.get("row_count"),
                    "metrics": _clamp_lists(metrics),
                    "findings": findings[:_MAX_DIST],
                }
                detected = imp.get("format")
            else:
                return _err(f"Unsupported dataset type: {ds['dataset_type']}")
        except Exception as exc:  # noqa: BLE001 — surface a clean, redacted message
            note("analyze_uploaded_file", ds.get("source_filename") or dataset_id, "error")
            return _err(f"Could not analyze the file: {exc}")

        # No silent cap: if ingestion hit the row ceiling, tell the model the
        # metrics are a lower bound over the first N rows, not the whole file.
        if imp.get("truncated"):
            cap = int(imp.get("ingest_cap") or 0)
            result["truncated"] = True
            result["rows_analyzed"] = int(imp.get("row_count") or 0)
            cap_note = (
                f"This file exceeded the analysis ingest cap ({cap:,} rows); only the "
                f"first {result['rows_analyzed']:,} rows were analyzed. Report the metrics "
                "as a LOWER BOUND over the analyzed rows — NOT the whole file — and, if the "
                "user needs full coverage, suggest splitting the file or a narrower slice."
            )
            prior = result.get("note")
            result["note"] = (prior + " " + cap_note) if prior else cap_note

        ds_repo.mark_imported(conn, dataset_id, duckdb_rel,
                              imp.get("table_name") or "", int(imp.get("row_count") or 0),
                              detected_format=detected)
        # Rule 17: a data import + analysis must leave an audit trail.
        audit.record(conn, "session.analyze_uploaded_file", {
            "session_id": session_id, "dataset_id": dataset_id,
            "type": ds["dataset_type"], "detected_format": detected,
            "row_count": int(imp.get("row_count") or 0),
        }, run_id=None)
        conn.commit()
        note("analyze_uploaded_file", ds.get("source_filename") or dataset_id,
             f"{imp.get('row_count', 0)} rows")
        # Redact defensively before it reaches the model.
        return redact_text(json.dumps(result, default=str))

    return [list_uploaded_files, analyze_uploaded_file]


__all__ = ["build"]
