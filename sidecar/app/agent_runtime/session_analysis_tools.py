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
from pathlib import Path
import uuid

from typing import Any, Callable

from .. import audit, config, db
from ..analysis import access_logs, aggregate as agg, inventory
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

    def note(tool: str, target: str, result: str, ok: bool = True) -> None:
        # `id` and `ok` (v0.55.0): the thread can key a row exactly instead of
        # matching on (tool, target), and knows a failure without pattern-matching
        # the result text.
        if activity is not None:
            activity.append({"id": uuid.uuid4().hex, "tool": tool, "target": target[:80],
                             "result": result[:80], "ok": ok, "status": "completed"})

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
        with db.transaction(conn):
            audit.record(conn, "session.list_uploaded_files",
                         {"session_id": session_id, "count": len(items)}, run_id=None, session_id=session_id)
            conn.commit()
        note("list_uploaded_files", session_id or "", f"{len(items)} file(s)")
        return json.dumps({"files": items})

    def _truncation_of(ds: dict[str, Any],
                       imp: dict[str, Any] | None) -> tuple[int, int] | None:
        """``(ingest_cap, rows_analyzed)`` when this dataset was truncated, else None.

        Prefers the live import result and falls back to what the dataset row
        recorded, so the answer is the same whether or not THIS call did the
        import. A row imported before the columns existed has `truncated` NULL —
        unknown, which is reported as not-truncated rather than invented, and
        self-corrects the next time the file is re-imported.
        """
        if imp is not None:
            if not imp.get("truncated"):
                return None
            return int(imp.get("ingest_cap") or 0), int(imp.get("row_count") or 0)
        if not ds.get("truncated"):
            return None
        return int(ds.get("ingest_cap") or 0), int(ds.get("row_count") or 0)

    def _ensure_imported(ds: dict[str, Any]) -> tuple[Path, dict[str, Any] | None, str | None]:
        """Return ``(duckdb_path, imp_or_none, detected_format)`` for a dataset,
        importing the raw upload only if needed.

        Shared by analyze_uploaded_file and aggregate_uploaded_file so neither
        re-imports on every call. ``imp_or_none`` is the fresh import metadata
        when a (re)import happened, else None (the table was reused); ``detected``
        is the reused row's stored format in that case.
        """
        dataset_id = ds["id"]
        duckdb_abs = config.data_dir() / "sessions" / str(session_id) / f"{dataset_id}.duckdb"
        # Reuse the built table ONLY when the dataset row says it's imported —
        # NOT on mere file existence. Re-uploading the same filename reuses the
        # row id and resets status to 'uploaded' (upsert) while the old
        # <dataset_id>.duckdb lingers on disk; keying on the file would answer
        # from the previous upload's (possibly wrong-typed) table. When status
        # isn't 'imported' we re-import, which DROPs and rebuilds the table.
        if ds.get("status") == "imported" and duckdb_abs.exists():
            return duckdb_abs, None, ds.get("detected_format")
        raw_abs = config.data_dir() / (ds.get("stored_path") or "")
        if not ds.get("stored_path") or not raw_abs.exists():
            raise FileNotFoundError("The uploaded file is no longer available on disk.")
        duckdb_abs.parent.mkdir(parents=True, exist_ok=True)
        if ds["dataset_type"] == "access_log":
            fmt = access_logs.detect_log_format(raw_abs)
            imp = access_logs.import_access_logs(raw_abs, duckdb_abs, fmt.get("format"))
            detected = fmt.get("format")
        else:
            imp = inventory.import_inventory_file(raw_abs, duckdb_abs)
            detected = imp.get("format")
        # Guard against a concurrent re-upload of the same filename (which resets
        # the row to a NEW stored_path): if stored_path changed under us, this
        # import is of the now-stale file — don't stamp it 'imported' over the new
        # upload. mark_imported returns False in that case; treat the result as a
        # transient miss so the next call re-imports the current file.
        with db.transaction(conn):
            imported = ds_repo.mark_imported(
                conn, dataset_id, config.rel_path(duckdb_abs),
                imp.get("table_name") or "", int(imp.get("row_count") or 0),
                detected_format=detected, expected_stored_path=ds.get("stored_path"),
                truncated=bool(imp.get("truncated")),
                ingest_cap=int(imp.get("ingest_cap") or 0) or None)
            if not imported:
                conn.commit()
        if not imported:
            raise FileNotFoundError(
                "The uploaded file was replaced during analysis; retry to analyze the new upload.")
        # Rule 17: audit the DATA IMPORT here, at the import itself — not only as a
        # side effect of a SUCCESSFUL analyze/aggregate. An aggregate that imports
        # the whole file and then fails (e.g. a bad metric) otherwise left a
        # completed import with no audit trail.
        with db.transaction(conn):
            audit.record(conn, "session.import_dataset",
                         {"session_id": session_id, "dataset_id": dataset_id,
                          "dataset_type": ds["dataset_type"], "detected_format": detected,
                          "row_count": int(imp.get("row_count") or 0)},
                         run_id=None, session_id=session_id)
            conn.commit()
        return duckdb_abs, imp, detected

    @function_tool
    def analyze_uploaded_file(dataset_id: str) -> str:
        """Analyze one uploaded file (access log or inventory export) locally with DuckDB and return SANITIZED aggregates: for access logs — total requests, status/method distributions, 4xx/5xx rates, top keys/prefixes/user-agents, requests-by-hour, plus rule-based findings; for inventory — object count, total/avg size, storage-class and prefix distributions, small-object ratio. Use the result to answer the user in your own words; if the data is not actually a recognized access log or inventory (e.g. a generic application log with no HTTP fields), say so plainly and describe what the file does contain rather than reporting meaningless zeros. Very large files are analyzed up to a row cap: when the result has "truncated": true, the metrics cover only the first rows_analyzed rows — report them as a lower bound, not the whole file. Args: dataset_id (from list_uploaded_files)."""
        ds = ds_repo.get(conn, dataset_id)
        if ds is None or ds.get("session_id") != session_id:
            return _err("Unknown dataset_id for this session. Call list_uploaded_files first.")
        if not ds.get("stored_path"):
            return _err("That upload has no stored file.")

        try:
            # Same reuse + staleness logic as aggregate_uploaded_file — import
            # only when the table isn't already built (was: re-imported every call).
            duckdb_abs, imp, detected = _ensure_imported(ds)
            if ds["dataset_type"] == "access_log":
                metrics = access_logs.analyze_access_logs(duckdb_abs)
                findings = access_logs.derive_findings(metrics)
                result: dict[str, Any] = {
                    "dataset_id": dataset_id,
                    "filename": ds["source_filename"],
                    "type": "access_log",
                    "detected_format": detected,
                    "row_count": (imp.get("row_count") if imp else ds.get("row_count")),
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
                metrics = inventory.analyze_inventory(duckdb_abs)
                findings = inventory.derive_findings(metrics)
                result = {
                    "dataset_id": dataset_id,
                    "filename": ds["source_filename"],
                    "type": "inventory",
                    "detected_format": detected,
                    "row_count": (imp.get("row_count") if imp else ds.get("row_count")),
                    "metrics": _clamp_lists(metrics),
                    "findings": findings[:_MAX_DIST],
                }
            else:
                return _err(f"Unsupported dataset type: {ds['dataset_type']}")
        except Exception as exc:  # noqa: BLE001 — surface a clean, redacted message
            note("analyze_uploaded_file", ds.get("source_filename") or dataset_id, "error", ok=False)
            return _err(f"Could not analyze the file: {exc}")

        # No silent cap: if the import hit the row ceiling, tell the model the
        # metrics are a lower bound over the first N rows, not the whole file.
        #
        # Read from the DATASET, not from `imp` (v0.80.0). `imp` is only present
        # on the call that actually imported, so this used to caveat the first
        # turn and then go quiet: every follow-up question re-read the same
        # truncated table and got the metrics described as the whole file.
        # Multi-turn is the normal way this product is used, so the silent case
        # was the common one.
        trunc = _truncation_of(ds, imp)
        if trunc:
            cap, analyzed = trunc
            result["truncated"] = True
            result["rows_analyzed"] = analyzed
            cap_note = (
                f"This file exceeded the analysis ingest cap ({cap:,} rows); only the "
                f"first {result['rows_analyzed']:,} rows were analyzed. Report the metrics "
                "as a LOWER BOUND over the analyzed rows — NOT the whole file — and, if the "
                "user needs full coverage, suggest splitting the file or a narrower slice."
            )
            prior = result.get("note")
            result["note"] = (prior + " " + cap_note) if prior else cap_note

        # Rule 17: a data import + analysis must leave an audit trail.
        with db.transaction(conn):
            audit.record(conn, "session.analyze_uploaded_file", {
                "session_id": session_id, "dataset_id": dataset_id,
                "type": ds["dataset_type"], "detected_format": detected,
                "row_count": int(result.get("row_count") or 0),
            }, run_id=None, session_id=session_id)
            conn.commit()
        note("analyze_uploaded_file", ds.get("source_filename") or dataset_id,
             f"{result.get('row_count', 0)} rows")
        # Redact defensively before it reaches the model.
        return redact_text(json.dumps(result, default=str))

    @function_tool
    def aggregate_uploaded_file(
        dataset_id: str,
        metric: str,
        group_by: str = "",
        group_by_2: str = "",
        filters_json: str = "",
        status_min: int = -1,
        status_max: int = -1,
        limit: int = 20,
    ) -> str:
        """Run ONE custom aggregation over an uploaded file when the fixed analyze_uploaded_file metrics don't answer the user's question (e.g. "which masked IP got the most 403s between status 400-499", "403s per masked-IP per day", "total bytes per storage class"). You choose metric + up to TWO group-by dimensions + equality filters from a whitelist; raw rows and arbitrary SQL are never available. access_log metrics: count, sum_bytes, avg_bytes, min_bytes, max_bytes, avg_latency_ms, p50/p95/p99_latency_ms, max_latency_ms, distinct_ips, distinct_keys; group_by: status_code, method, key, path, prefix, user_agent, client_ip_masked, error_code, hour, day, weekday. inventory metrics: count, total_size, avg_size, max_size, min_size, distinct_prefixes, distinct_storage_classes; group_by: bucket, prefix, storage_class. group_by_2 (optional) adds a second dimension for a cross-tab (e.g. group_by=client_ip_masked, group_by_2=day); the returned group label joins the two with " · ". filters_json: optional JSON object of column->value equality filters (same columns as group_by, except derived hour/day/weekday). status_min/status_max: optional status-code range (access logs; pass -1 to skip). limit: max groups returned (<=50); a "truncated": true means more groups exist. Args: dataset_id (from list_uploaded_files), metric, group_by (empty for a single scalar), group_by_2 (optional), filters_json, status_min, status_max, limit."""
        ds = ds_repo.get(conn, dataset_id)
        if ds is None or ds.get("session_id") != session_id:
            return _err("Unknown dataset_id for this session. Call list_uploaded_files first.")
        if ds["dataset_type"] not in ("access_log", "inventory"):
            return _err(f"Unsupported dataset type: {ds['dataset_type']}")

        filters: dict[str, Any] = {}
        if filters_json.strip():
            try:
                parsed = json.loads(filters_json)
            except json.JSONDecodeError:
                return _err("filters_json must be a JSON object like {\"method\": \"GET\"}.")
            if not isinstance(parsed, dict):
                return _err("filters_json must be a JSON object of column -> value.")
            filters = parsed

        try:
            duckdb_abs, _imp, _detected = _ensure_imported(ds)
            _trunc = _truncation_of(ds, _imp)
            out = agg.aggregate(
                duckdb_abs, ds["dataset_type"], metric,
                group_by=group_by or None, group_by_2=group_by_2 or None, filters=filters,
                status_min=None if status_min < 0 else status_min,
                status_max=None if status_max < 0 else status_max,
                limit=limit,
            )
        except agg.AggregateError as exc:
            # The message lists the allowed values so the agent self-corrects.
            return _err(str(exc))
        except Exception as exc:  # noqa: BLE001 — surface a clean, redacted message
            note("aggregate_uploaded_file", ds.get("source_filename") or dataset_id, "error", ok=False)
            return _err(f"Could not aggregate the file: {exc}")

        # Rule 17: record the ACTUAL SQL + bound params in the audit trail.
        with db.transaction(conn):
            audit.record(conn, "session.aggregate_uploaded_file", {
                "session_id": session_id, "dataset_id": dataset_id,
                "sql": out["sql"], "params": [redact_text(str(p))[:100] for p in out["params"]],
                "groups": len(out.get("groups", [])),
            }, run_id=None, session_id=session_id)
            conn.commit()

        result = {
            "dataset_id": dataset_id,
            "filename": ds["source_filename"],
            "type": ds["dataset_type"],
            "metric": out["metric"],
            "group_by": out["group_by"],
            "truncated": out["truncated"],
        }
        if "groups" in out:
            result["groups"] = out["groups"]
            if out["truncated"]:
                result["note"] = (
                    "More groups exist beyond this limit — the list is the top "
                    f"{len(out['groups'])} by the metric, not the full set."
                )
        else:
            result["value"] = out["value"]
        # The dataset itself may be a truncated read of the file, which this tool
        # never mentioned — not even on the importing call, since it discarded the
        # import metadata (v0.80.0). Deliberately NOT called `truncated`: that key
        # already means "more GROUPS exist beyond the limit" here, and collapsing
        # a partial file into the same word is how a caveat stops being read.
        if _trunc:
            cap, analyzed = _trunc
            result["source_truncated"] = True
            result["rows_analyzed"] = analyzed
            src_note = (
                f"The underlying file exceeded the analysis ingest cap ({cap:,} rows); "
                f"this aggregate covers only the first {analyzed:,} rows. Every number "
                "here is a LOWER BOUND over the analyzed rows, not the whole file."
            )
            prior = result.get("note")
            result["note"] = (prior + " " + src_note) if prior else src_note
        summary = (f"{len(out['groups'])} groups" if "groups" in out
                   else f"value={out.get('value')}")
        note("aggregate_uploaded_file", ds.get("source_filename") or dataset_id,
             f"{metric} by {group_by or '(all)'} → {summary}")
        return redact_text(json.dumps(result, default=str))

    return [list_uploaded_files, analyze_uploaded_file, aggregate_uploaded_file]


__all__ = ["build"]
