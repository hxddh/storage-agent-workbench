"""Observability export — structured traces for the native agent.

Exposes the durable execution log + turn metrics + audit as a portable
OTel-inspired JSON payload. No new storage, no secrets: every record is already
persisted in sanitized form; this endpoint merely projects it.

Endpoints:
  GET /agent-tasks/{task_id}/export/otel   — per-task export (bounded)
  GET /observability/export                — global bounded health snapshot

The per-task export carries both the raw durable `events` and a derived
`spans` projection (deterministic trace_id/span_id + W3C `traceparent` per
span, v1.13) importable into Jaeger/Tempo. Span ids are derived, not stored:
no migration, same task always maps to the same trace.

Both are auth-gated (same Sidecar token) and bounded to prevent unbounded dumps.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn

router = APIRouter(tags=["observability"])

# Bounds: never dump an unbounded task.
MAX_EVENTS = 500
MAX_TOOL_CALLS = 200
MAX_AUDIT = 200


def _trace_id(task_id: str) -> str:
    """Deterministic 32-hex trace id for a task (v1.13, no migration).

    Derived, not stored: the same task always maps to the same trace so an
    export opened in Jaeger correlates across repeated pulls."""
    return hashlib.sha256(f"storage-agent:task:{task_id}".encode()).hexdigest()[:32]


def _span_id(*parts: object) -> str:
    """Deterministic 16-hex span id from stable parts."""
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p).encode())
        h.update(b"\x00")
    return h.hexdigest()[:16]


def _traceparent(trace_id: str, span_id: str) -> str:
    """W3C traceparent header value (version 00, sampled)."""
    return f"00-{trace_id}-{span_id}-01"


# Durable event types projected as OTel spans (v1.13). Everything else stays
# in the raw `events` section only.
_SPAN_EVENTS = frozenset({
    "tool.started", "tool.completed", "plan.updated", "approval.opened",
    "approval.granted", "steer.received", "steer.applied",
    "message.completed", "context.compacted", "decision.resolved",
    "work_result.recorded", "execution.status", "task.status",
    "context.updated", "task.titled",
})


def _event_spans(task_id: str, events: list[dict]) -> list[dict]:
    """Project durable events as OTel-inspired spans.

    One parent span per execution (`execution:<id>`); each event is a child
    span carrying the sanitized payload as attributes. Timestamps reuse the
    event's `created_at` for start/end (durations come from the payload's
    `duration_ms` where the emitter recorded one)."""
    trace_id = _trace_id(task_id)
    spans: list[dict] = []
    seen_execs: dict[str, str] = {}
    for ev in events:
        if ev.get("event_type") not in _SPAN_EVENTS:
            continue
        exec_id = str(ev.get("execution_id") or "")
        parent = seen_execs.get(exec_id)
        if parent is None:
            parent = _span_id("execution", exec_id or task_id)
            seen_execs[exec_id] = parent
            spans.append({
                "trace_id": trace_id,
                "span_id": parent,
                "parent_span_id": None,
                "traceparent": _traceparent(trace_id, parent),
                "name": f"execution:{exec_id[:8]}" if exec_id else "task",
                "kind": "internal",
                "start": None,
                "end": None,
                "attributes": {"execution_id": exec_id} if exec_id else {},
            })
        sid = _span_id("event", exec_id, ev.get("seq"))
        try:
            attrs = json.loads(ev.get("payload") or "{}")
            if not isinstance(attrs, dict):
                attrs = {"value": attrs}
        except (TypeError, ValueError):
            attrs = {}
        attrs = {"seq": ev.get("seq"), "execution_id": exec_id, **attrs}
        spans.append({
            "trace_id": trace_id,
            "span_id": sid,
            "parent_span_id": parent,
            "traceparent": _traceparent(trace_id, sid),
            "name": str(ev.get("event_type")),
            "kind": "internal",
            "start": ev.get("at"),
            "end": ev.get("at"),
            "duration_ms": attrs.get("duration_ms"),
            "attributes": attrs,
        })
    return spans


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
                "SELECT seq, execution_id, event_type, payload_json_sanitized, created_at "
                "FROM execution_events WHERE task_id = ? ORDER BY seq DESC LIMIT ?",
                (task_id, limit_events),
            ).fetchall()
            payload["events"] = [
                {
                    "seq": r["seq"],
                    "execution_id": r["execution_id"],
                    "type": r["event_type"],
                    "payload": r["payload_json_sanitized"],
                    "at": r["created_at"],
                }
                for r in reversed(events)
            ]
            payload["events_truncated"] = len(events) == limit_events
            # v1.13 — OTel span projection of the same events (derived ids,
            # no new storage). Importable into Jaeger/Tempo via the OTLP/JSON
            # span shape (trace_id/span_id/traceparent).
            payload["trace_id"] = _trace_id(task_id)
            payload["spans"] = _event_spans(task_id, payload["events"])
        except Exception as exc:  # noqa: BLE001
            logging.getLogger(__name__).warning(
                "OTel export: execution_events read failed (%s)", type(exc).__name__)
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
