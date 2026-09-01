"""Observability export — structured traces for the native agent.

Exposes the durable execution log + turn metrics + audit as a portable
OTel-inspired JSON payload. No new storage, no secrets: every record is already
persisted in sanitized form; this endpoint merely projects it.

Endpoints:
  GET /agent-tasks/{task_id}/export/otel   — per-task export (bounded)
  GET /observability/export                — global bounded health snapshot

Both are auth-gated (same Sidecar token) and bounded to prevent unbounded dumps.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn

router = APIRouter(tags=["observability"])

# Bounds: never dump an unbounded task.
MAX_EVENTS = 500
MAX_TOOL_CALLS = 200
MAX_AUDIT = 200


@router.get("/agent-tasks/{task_id}/export/otel")
def export_task_otel(
    task_id: str,
    include_events: bool = True,
    include_tool_calls: bool = True,
    include_audit: bool = False,
    limit_events: int = Query(default=200, ge=1, le=MAX_EVENTS),
    conn: sqlite3.Connection = Depends(get_conn),
):
    """Export a task's durable execution trace in OTel-inspired JSON.

    Query params:
      include_events, include_tool_calls, include_audit — which sections to include
      limit_events — cap on execution_events rows (1..500)
    """
    # Validate task exists (404 rather than empty export).
    row = conn.execute("SELECT id, title FROM sessions WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        row2 = conn.execute("SELECT id FROM agent_tasks WHERE id = ?", (task_id,)).fetchone()
        if row2 is None:
            raise HTTPException(status_code=404, detail="task not found")
    # Also check task_runtime store for richer context, but sessions is enough.

    payload: dict[str, object] = {"task_id": task_id, "export": "otel-v1"}

    # Task state snapshot
    try:
        task_row = conn.execute(
            "SELECT status, active_execution_id, context_version, updated_at FROM agent_tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        if task_row:
            payload["task"] = {
                "status": task_row["status"],
                "active_execution_id": task_row["active_execution_id"],
                "context_version": task_row["context_version"],
                "updated_at": task_row["updated_at"],
            }
    except Exception:  # noqa: BLE001
        pass

    # Execution events (sanitized, bounded)
    if include_events:
        try:
            events = conn.execute(
                "SELECT seq, execution_id, event_type, payload_json, created_at "
                "FROM execution_events WHERE task_id = ? ORDER BY seq DESC LIMIT ?",
                (task_id, limit_events),
            ).fetchall()
            payload["events"] = [
                {
                    "seq": r["seq"],
                    "execution_id": r["execution_id"],
                    "type": r["event_type"],
                    "payload": r["payload_json"],
                    "at": r["created_at"],
                }
                for r in reversed(events)
            ]
            payload["events_truncated"] = len(events) == limit_events
        except Exception:  # noqa: BLE001
            payload["events"] = []
            payload["events_truncated"] = False

    # Tool calls
    if include_tool_calls:
        try:
            calls = conn.execute(
                "SELECT id, tool_name, status, duration_ms, created_at FROM tool_calls "
                "WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
                (task_id, MAX_TOOL_CALLS),
            ).fetchall()
            payload["tool_calls"] = [
                {
                    "id": r["id"],
                    "tool": r["tool_name"],
                    "status": r["status"],
                    "duration_ms": r["duration_ms"],
                    "at": r["created_at"],
                }
                for r in reversed(calls)
            ]
        except Exception:  # noqa: BLE001
            payload["tool_calls"] = []

    # Turn metrics
    try:
        metrics = conn.execute(
            "SELECT id, turn_id, model, input_tokens, output_tokens, total_tokens, "
            "cached_input_tokens, reasoning_tokens, duration_ms, tool_call_count, budget_tokens "
            "FROM turn_metrics WHERE session_id = ? ORDER BY created_at DESC LIMIT 50",
            (task_id,),
        ).fetchall()
        payload["turn_metrics"] = [
            {
                "id": r["id"],
                "turn_id": r["turn_id"],
                "model": r["model"],
                "input_tokens": r["input_tokens"],
                "output_tokens": r["output_tokens"],
                "total_tokens": r["total_tokens"],
                "cached_input_tokens": r["cached_input_tokens"],
                "reasoning_tokens": r["reasoning_tokens"],
                "duration_ms": r["duration_ms"],
                "tool_call_count": r["tool_call_count"],
                "budget_tokens": r["budget_tokens"],
            }
            for r in reversed(metrics)
        ]
    except Exception:  # noqa: BLE001
        payload["turn_metrics"] = []

    # Audit (opt-in, sensitive — bounded)
    if include_audit:
        try:
            audits = conn.execute(
                "SELECT id, event_type, created_at FROM audit_logs WHERE session_id = ? "
                "ORDER BY created_at DESC LIMIT ?",
                (task_id, MAX_AUDIT),
            ).fetchall()
            payload["audit"] = [
                {"id": r["id"], "event": r["event_type"], "at": r["created_at"]}
                for r in reversed(audits)
            ]
        except Exception:  # noqa: BLE001
            payload["audit"] = []

    # Artifacts index
    try:
        arts = conn.execute(
            "SELECT id, artifact_type, title, ref_kind, status, created_at FROM task_artifacts "
            "WHERE task_id = ? ORDER BY created_at DESC LIMIT 50",
            (task_id,),
        ).fetchall()
        payload["artifacts"] = [
            {
                "id": r["id"],
                "type": r["artifact_type"],
                "title": r["title"],
                "ref_kind": r["ref_kind"],
                "status": r["status"],
                "at": r["created_at"],
            }
            for r in reversed(arts)
        ]
    except Exception:  # noqa: BLE001
        payload["artifacts"] = []

    return payload


@router.get("/observability/export")
def export_global(
    limit_tasks: int = Query(default=20, ge=1, le=100),
    conn: sqlite3.Connection = Depends(get_conn),
):
    """Global bounded health snapshot — task counts, recent executions, no secrets."""
    try:
        tasks = conn.execute(
            "SELECT id, status, updated_at FROM agent_tasks ORDER BY updated_at DESC LIMIT ?",
            (limit_tasks,),
        ).fetchall()
        task_list = [{"id": r["id"], "status": r["status"], "updated_at": r["updated_at"]} for r in tasks]
    except Exception:  # noqa: BLE001
        task_list = []

    try:
        execs = conn.execute(
            "SELECT id, task_id, status, kind, created_at, finished_at FROM task_executions "
            "ORDER BY created_at DESC LIMIT 50",
        ).fetchall()
        exec_list = [
            {
                "id": r["id"],
                "task_id": r["task_id"],
                "status": r["status"],
                "kind": r["kind"],
                "created_at": r["created_at"],
                "finished_at": r["finished_at"],
            }
            for r in execs
        ]
    except Exception:  # noqa: BLE001
        exec_list = []

    # Provider presence (no secrets, just whether a model is configured)
    try:
        from ..repositories import model_providers as mp_repo

        active = mp_repo.effective_active_id(conn)
        # Use repo list (sanitized) rather than raw row that might expose ref.
        prov_list = [
            {
                "id": p.id,
                "provider_type": p.provider_type,
                "model": p.model,
                "active": p.active,
                "has_key": p.has_api_key,
            }
            for p in mp_repo.list_all(conn)
        ]
    except Exception:  # noqa: BLE001
        prov_list = []
        active = None

    return {
        "export": "otel-global-v1",
        "tasks": task_list,
        "recent_executions": exec_list,
        "providers": prov_list,
        "active_provider_id": active,
    }
