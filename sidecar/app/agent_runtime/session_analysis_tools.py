"""Read-only analysis tools the in-chat agent uses on data already on this machine.

Two sources, one engine and one whitelist:

- files the user attaches in the conversation (``session_datasets``), and
- evidence this session already imported from the cloud (``datasets``, written
  by the confirmed evidence-import runs).

The second used to dead-end: after a confirmed import the agent's only way back
to the data was the run's fixed ``final_summary``, so a follow-up question about
the logs it had just downloaded could not be answered — while the same question
about a file dragged into the chat could. The expensive path was the one that
could not be asked twice.

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

Always available to the session agent regardless of autonomy policy — reading
local data the user already handed over (or already confirmed the import of) is
safe-by-construction and not data-moving. Nothing here makes a network call:
the imported-evidence tools read the run's local DuckDB file and can neither
trigger a download nor widen what an import may fetch.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
import uuid

from typing import Any, Callable

from .. import audit, config, db
from ..analysis import access_logs, aggregate as agg, inventory
from ..repositories import datasets as run_ds_repo
from ..repositories import session_datasets as ds_repo
from ..repositories import sessions as sessions_repo
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
        import. Rows imported before the columns existed cannot reach this with
        NULL: migration 24 sent them back to 'uploaded', so the next analysis
        re-imports and establishes the fact. (Without that, nothing ever would —
        the built table is reused while the row says 'imported', so the importer
        would never run again and an old oversized upload would answer
        uncaveated forever.)
        """
        if imp is not None:
            if not imp.get("truncated"):
                return None
            return int(imp.get("ingest_cap") or 0), int(imp.get("row_count") or 0)
        if not ds.get("truncated"):
            return None
        return int(ds.get("ingest_cap") or 0), int(ds.get("row_count") or 0)

    def _truncation_unknown(ds: dict[str, Any], imp: dict[str, Any] | None) -> bool:
        """True when the table was reused and nothing ever recorded whether the
        import was complete.

        Migration 24 resets pre-existing rows so this should not arise, but the
        whole point of this sweep is that an unknown quietly rendered as "fine"
        is the defect. If one appears anyway, say so rather than answer as if
        the file were whole."""
        return imp is None and ds.get("truncated") is None

    # How a metric behaves when only the first N rows of a file are read.
    #
    # "Lower bound" is true for counts, sums, maxima and distinct-counts: the
    # unread rows can only add. It is FALSE for averages and percentiles, which
    # can move either way, and backwards for minima, which can only fall. Saying
    # "lower bound" for `avg_size` would hand the model a wrong inequality and
    # invite it to reason from it — a caveat that misleads is worse than none.
    _MONOTONE_UP = ("count", "sum_", "total_", "max_", "distinct_")
    _MONOTONE_DOWN = ("min_",)

    def _bound_phrase(metric: str) -> str:
        if metric.startswith(_MONOTONE_UP):
            return ("a LOWER BOUND — the unanalyzed rows can only add to it, "
                    "never subtract")
        if metric.startswith(_MONOTONE_DOWN):
            return ("an UPPER BOUND — an unanalyzed row can only be smaller, "
                    "never larger")
        return ("neither an upper nor a lower bound — an average or percentile "
                "over the first rows can be higher OR lower than over the whole "
                "file, so treat it as describing the analyzed rows only")

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
                f"first {result['rows_analyzed']:,} rows were analyzed — NOT the whole "
                "file. Counts, totals and maxima below are LOWER BOUNDS (the unanalyzed "
                "rows can only add). Averages, ratios and minima are NOT bounds: they "
                "describe the analyzed rows and can move either way over the full file, "
                "so do not reason from them as if they were limits. If the user needs "
                "full coverage, suggest splitting the file or a narrower slice."
            )
            prior = result.get("note")
            result["note"] = (prior + " " + cap_note) if prior else cap_note
        elif _truncation_unknown(ds, imp):
            result["truncation_unknown"] = True
            unk = ("It is NOT recorded whether this file was read in full or stopped at "
                   "the ingest cap, so the metrics may cover only part of it. Say that "
                   "the coverage is unknown rather than presenting them as the whole "
                   "file; re-uploading the file re-establishes it.")
            prior = result.get("note")
            result["note"] = (prior + " " + unk) if prior else unk

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
                f"this aggregate covers only the first {analyzed:,} rows, not the whole "
                f"file. For `{metric}` that makes the value {_bound_phrase(metric)}."
            )
            prior = result.get("note")
            result["note"] = (prior + " " + src_note) if prior else src_note
        summary = (f"{len(out['groups'])} groups" if "groups" in out
                   else f"value={out.get('value')}")
        note("aggregate_uploaded_file", ds.get("source_filename") or dataset_id,
             f"{metric} by {group_by or '(all)'} → {summary}")
        return redact_text(json.dumps(result, default=str))

    # ---------------------------------------------------------------- imported
    # evidence. Same engine, same whitelist, same caveats — a different source.

    def _session_evidence() -> list[Any]:
        """Imported datasets belonging to runs linked to THIS session.

        Scoping is the whole security story here: a dataset is reachable only
        through a run this session owns, so one session can never aggregate
        another's imported evidence.
        """
        run_ids = [r["run_id"] for r in sessions_repo.list_runs(conn, session_id)]
        out = []
        for rid in run_ids:
            for d in run_ds_repo.list_for_run(conn, rid):
                if d.status == "imported" and d.duckdb_path:
                    out.append(d)
        return out

    def _evidence_caveat(d: Any) -> str | None:
        """What this dataset's row says about covering the whole source file."""
        if d.truncated:
            cap = int(d.ingest_cap or 0)
            rows = int(d.row_count or 0)
            return (f"The import stopped at the ingest cap ({cap:,} rows); this covers "
                    f"only the first {rows:,} rows of the source, not the whole file.")
        if d.truncated is None:
            # Imported before the columns existed. Unlike a conversation upload,
            # a run dataset is never re-imported, so this never self-corrects —
            # report the unknown instead of implying completeness.
            return ("This dataset was imported before completeness was recorded, so "
                    "whether it covers the whole source file is UNKNOWN. Re-import the "
                    "evidence if the answer needs to be exact.")
        return None

    @function_tool
    def list_imported_evidence() -> str:
        """List the cloud evidence (access logs, inventory exports) this session has ALREADY imported and can be queried locally with aggregate_imported_evidence — no new download, no S3 call. Use this when the user follows up on an import ("which IP got the most 403s?", "biggest prefixes?") instead of re-importing or asking them to attach the file by hand. Returns each dataset's id, type, source filename, row count, originating run_id, and whether the import covered the whole source file. Args: none."""
        items = [
            {
                "dataset_id": d.id,
                "type": d.dataset_type,
                "filename": d.source_filename,
                "row_count": d.row_count,
                "run_id": d.run_id,
                # Tri-state on purpose: True / False / None(unknown).
                "covers_whole_source": (None if d.truncated is None else not d.truncated),
            }
            for d in _session_evidence()
        ]
        with db.transaction(conn):
            audit.record(conn, "session.list_imported_evidence",
                         {"session_id": session_id, "count": len(items)},
                         run_id=None, session_id=session_id)
            conn.commit()
        note("list_imported_evidence", session_id or "", f"{len(items)} dataset(s)")
        return json.dumps({"datasets": items})

    @function_tool
    def aggregate_imported_evidence(
        dataset_id: str,
        metric: str,
        group_by: str = "",
        group_by_2: str = "",
        filters_json: str = "",
        status_min: int = -1,
        status_max: int = -1,
        limit: int = 20,
    ) -> str:
        """Run ONE custom aggregation over evidence this session ALREADY imported from the cloud — the follow-up question the import run's fixed summary does not answer ("which masked IP got the most 403s", "total bytes per storage class"). Reads the run's local DuckDB only: no S3 call, no download, no raw rows, no SQL. Metrics, group-by dimensions and filters are the SAME whitelist as aggregate_uploaded_file — access_log metrics: count, sum_bytes, avg_bytes, min_bytes, max_bytes, avg_latency_ms, p50/p95/p99_latency_ms, max_latency_ms, distinct_ips, distinct_keys; group_by: status_code, method, key, path, prefix, user_agent, client_ip_masked, error_code, hour, day, weekday. inventory metrics: count, total_size, avg_size, max_size, min_size, distinct_prefixes, distinct_storage_classes; group_by: bucket, prefix, storage_class. group_by_2 adds a second dimension (labels joined with " · "). filters_json: JSON object of column->value equality filters. status_min/status_max: status-code range (access logs; -1 to skip). limit: max groups (<=50); "truncated": true means more groups exist, while "source_truncated" means the IMPORT itself did not cover the whole file. Args: dataset_id (from list_imported_evidence), metric, group_by, group_by_2, filters_json, status_min, status_max, limit."""
        allowed = {d.id: d for d in _session_evidence()}
        d = allowed.get(dataset_id)
        if d is None:
            return _err("Unknown dataset_id for this session. Call list_imported_evidence "
                        "first; only evidence imported by THIS session can be queried.")
        if d.dataset_type not in ("access_log", "inventory"):
            return _err(f"Unsupported dataset type: {d.dataset_type}")

        filters: dict[str, Any] = {}
        if filters_json.strip():
            try:
                parsed = json.loads(filters_json)
            except json.JSONDecodeError:
                return _err("filters_json must be a JSON object like {\"method\": \"GET\"}.")
            if not isinstance(parsed, dict):
                return _err("filters_json must be a JSON object of column -> value.")
            filters = parsed

        duckdb_abs = config.data_dir() / str(d.duckdb_path)
        if not Path(duckdb_abs).exists():
            return _err("The imported analysis database for this dataset is missing "
                        "(the run's files may have been cleaned up). Re-import the evidence.")
        try:
            out = agg.aggregate(
                duckdb_abs, d.dataset_type, metric,
                group_by=group_by or None, group_by_2=group_by_2 or None, filters=filters,
                status_min=None if status_min < 0 else status_min,
                status_max=None if status_max < 0 else status_max,
                limit=limit,
            )
        except agg.AggregateError as exc:
            return _err(str(exc))
        except Exception as exc:  # noqa: BLE001 — surface a clean, redacted message
            note("aggregate_imported_evidence", d.source_filename or dataset_id, "error", ok=False)
            return _err(f"Could not aggregate the imported evidence: {exc}")

        # Rule 17: the ACTUAL SQL + bound params land in the audit trail.
        with db.transaction(conn):
            audit.record(conn, "session.aggregate_imported_evidence", {
                "session_id": session_id, "dataset_id": dataset_id, "run_id": d.run_id,
                "sql": out["sql"], "params": [redact_text(str(p))[:100] for p in out["params"]],
                "groups": len(out.get("groups", [])),
            }, run_id=d.run_id, session_id=session_id)
            conn.commit()

        result: dict[str, Any] = {
            "dataset_id": dataset_id,
            "filename": d.source_filename,
            "type": d.dataset_type,
            "run_id": d.run_id,
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
        caveat = _evidence_caveat(d)
        if caveat:
            # Same distinction the upload path draws: `truncated` is about GROUPS,
            # `source_truncated` is about the FILE. One word for both is how a
            # caveat stops being read.
            result["source_truncated"] = True if d.truncated else None
            if d.truncated:
                result["rows_analyzed"] = d.row_count
                caveat += f" For `{metric}` that makes the value {_bound_phrase(metric)}."
            prior = result.get("note")
            result["note"] = (prior + " " + caveat) if prior else caveat
        summary = (f"{len(out['groups'])} groups" if "groups" in out
                   else f"value={out.get('value')}")
        note("aggregate_imported_evidence", d.source_filename or dataset_id,
             f"{metric} by {group_by or '(all)'} → {summary}")
        return redact_text(json.dumps(result, default=str))

    return [list_uploaded_files, analyze_uploaded_file, aggregate_uploaded_file,
            list_imported_evidence, aggregate_imported_evidence]


__all__ = ["build"]
