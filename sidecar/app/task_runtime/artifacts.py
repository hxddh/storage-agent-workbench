"""First-class Artifact registrar.

Reports, evidence imports, and analysis runs were each persisted in their own
corner (a rendered markdown body, an evidence_imports row, a runs row) with no
task-level object tying them together. Each registrar call indexes one durable
artifact against its Agent Task — pointing at the durable thing (ref_kind /
ref_id), never duplicating it — and appends the structured event so Review can
show artifacts appearing as they are produced.

Best-effort by contract: artifact indexing must never fail the operation that
produced the artifact. Callers may rely on that.
"""

from __future__ import annotations

import sqlite3

from . import store


def _record(conn: sqlite3.Connection, task_id: str | None, artifact_type: str,
            **kwargs) -> str | None:
    if not task_id:
        return None
    try:
        if store.get_task(conn, task_id) is None:
            store.ensure_task(conn, task_id)
        execution_id = kwargs.get("execution_id")
        art_id = store.record_artifact(conn, task_id, artifact_type, **kwargs)
        store.append_event(conn, execution_id or "", task_id, "artifact.recorded",
                           {"artifact_id": art_id, "artifact_type": artifact_type,
                            "title": kwargs.get("title")}, commit=False)
        conn.commit()
        return art_id
    except Exception:  # noqa: BLE001 — indexing never breaks the producer
        return None


def record_report(conn: sqlite3.Connection, task_id: str | None,
                  title: str | None = None, *, ref_id: str | None = None,
                  execution_id: str | None = None) -> str | None:
    """A generated task report (sanitized markdown)."""
    return _record(conn, task_id, "report", title=title or "Task report",
                   ref_kind="session_report", ref_id=ref_id or task_id,
                   format="markdown", execution_id=execution_id)


def record_run_report(conn: sqlite3.Connection, task_id: str | None, run_id: str,
                      title: str | None = None) -> str | None:
    """A deterministic run's saved report artifact."""
    return _record(conn, task_id, "report", title=title or "Run report",
                   ref_kind="run", ref_id=run_id, format="markdown")


def record_evidence_import(conn: sqlite3.Connection, task_id: str | None,
                           import_id: str, source_type: str | None = None,
                           summary: str | None = None) -> str | None:
    """A confirmed, executed evidence import (the durable evidence snapshot)."""
    return _record(conn, task_id, "evidence_import",
                   title=f"Evidence import ({source_type})" if source_type
                   else "Evidence import",
                   ref_kind="evidence_import", ref_id=import_id, summary=summary)


def record_analysis(conn: sqlite3.Connection, task_id: str | None, run_id: str,
                    run_type: str | None = None, title: str | None = None) -> str | None:
    """A completed deterministic analysis run linked to the task."""
    return _record(conn, task_id, "analysis", title=title or (run_type or "Analysis"),
                   ref_kind="run", ref_id=run_id)


def record_remediation_plan(conn: sqlite3.Connection, task_id: str | None, plan_id: str,
                            title: str | None = None, *, execution_id: str | None = None,
                            summary: str | None = None, status: str | None = None) -> str | None:
    return _record(conn, task_id, "remediation_plan",
                   title=title or "Remediation plan",
                   ref_kind="remediation_plan", ref_id=plan_id,
                   format="json", summary=summary, execution_id=execution_id,
                   status=status or "proposed")


def record_baseline(conn: sqlite3.Connection, task_id: str | None, baseline_id: str,
                    title: str | None = None, *, execution_id: str | None = None,
                    summary: str | None = None) -> str | None:
    return _record(conn, task_id, "baseline",
                   title=title or "Task baseline",
                   ref_kind="task_baseline", ref_id=baseline_id,
                   format="json", summary=summary, execution_id=execution_id)


def record_drift_report(conn: sqlite3.Connection, task_id: str | None, *,
                        title: str | None = None, execution_id: str | None = None,
                        summary: str | None = None, payload: dict | None = None) -> str | None:
    ref_id = (payload or {}).get("baseline_id") or task_id
    return _record(conn, task_id, "drift_report",
                   title=title or "Drift report",
                   ref_kind="drift_report", ref_id=str(ref_id) if ref_id else task_id,
                   format="json", summary=summary, execution_id=execution_id,
                   payload=payload)
