"""Typed, versioned Storage Task Context.

The machine state a task needs to be picked back up — provider scope, buckets in
focus, evidence on hand, memory shape, open decisions — captured as a TYPED
document and persisted through ``task_context_versions``. Recovering a task
reads the latest version; it never replays chat to rebuild machine state.

The document is DERIVED deterministically from durable rows (it is a snapshot,
not a second source of truth), sanitized, and versioned append-only: a new
version is written only when the snapshot actually changed. ``schema_version``
gates future shape changes explicitly.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from ..security.redaction import redact_text
from . import store

SCHEMA_VERSION = 1

# Bounds: the context is a compact machine-state snapshot, never a data dump.
_MAX_DATASETS = 50
_MAX_RUNS = 50
_MAX_BUCKETS = 20


def build_snapshot(conn: sqlite3.Connection, task_id: str) -> dict[str, Any]:
    """The task's current typed context document, derived from durable state."""
    session = conn.execute("SELECT * FROM sessions WHERE id = ?", (task_id,)).fetchone()
    datasets = conn.execute(
        "SELECT id, dataset_type, status, detected_format, row_count "
        "FROM session_datasets WHERE session_id = ? ORDER BY rowid DESC LIMIT ?",
        (task_id, _MAX_DATASETS)).fetchall()
    runs = conn.execute(
        "SELECT sr.run_id, r.run_type, r.status, r.origin "
        "FROM session_runs sr JOIN runs r ON r.id = sr.run_id "
        "WHERE sr.session_id = ? ORDER BY sr.rowid DESC LIMIT ?",
        (task_id, _MAX_RUNS)).fetchall()
    imports = conn.execute(
        "SELECT ei.id, ei.source_type, ei.status FROM evidence_imports ei "
        "JOIN session_runs sr ON sr.run_id = ei.account_run_id "
        "WHERE sr.session_id = ? ORDER BY ei.rowid DESC LIMIT ?",
        (task_id, _MAX_RUNS)).fetchall()
    memory = conn.execute(
        "SELECT kind, count(*) n FROM session_agent_memory "
        "WHERE session_id = ? AND status = 'active' GROUP BY kind",
        (task_id,)).fetchall()
    # Buckets the investigation has actually touched: the session's primary
    # bucket plus targets of recent bucket-scoped probes (a bounded, factual
    # focus list — not a plan).
    bucket_rows = conn.execute(
        "SELECT DISTINCT json_extract(input_json_sanitized, '$.bucket') AS b "
        "FROM tool_calls WHERE session_id = ? "
        "AND json_valid(input_json_sanitized) "
        "AND json_extract(input_json_sanitized, '$.bucket') IS NOT NULL "
        "ORDER BY rowid DESC LIMIT ?", (task_id, _MAX_BUCKETS)).fetchall()
    pending = store.list_decisions(conn, task_id, status=store.DECISION_PENDING)
    return {
        "schema_version": SCHEMA_VERSION,
        "task_id": task_id,
        "goal": redact_text(str(session["goal"] or "")) if session else "",
        "provider_id": session["provider_id"] if session else None,
        "primary_bucket": redact_text(str(session["primary_bucket"] or "")) or None
        if session else None,
        "buckets_in_focus": sorted(
            {redact_text(str(r["b"]))[:200] for r in bucket_rows if r["b"]}),
        "attached_datasets": [
            {"id": d["id"], "dataset_type": d["dataset_type"], "status": d["status"],
             "detected_format": d["detected_format"], "row_count": d["row_count"]}
            for d in datasets],
        "evidence_imports": [
            {"id": i["id"], "source_type": i["source_type"], "status": i["status"]}
            for i in imports],
        "linked_runs": [
            {"run_id": r["run_id"], "run_type": r["run_type"], "status": r["status"],
             "origin": r["origin"]} for r in runs],
        "memory_counts": {m["kind"]: int(m["n"]) for m in memory},
        "open_decisions": [d["id"] for d in pending],
    }


def refresh(conn: sqlite3.Connection, task_id: str,
            execution_id: str | None = None) -> int | None:
    """Snapshot the current typed context and persist it as a new version if it
    changed. Returns the new version, or None when unchanged. Best-effort for
    callers on hot paths — they may wrap in try/except; a context bookkeeping
    failure must never fail an execution."""
    doc = build_snapshot(conn, task_id)
    return store.save_context_version(conn, task_id, doc, execution_id)
