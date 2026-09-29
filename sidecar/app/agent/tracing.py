"""Local tracing (v5): the Agents SDK's own spans, kept on this machine.

The SDK's default exporter uploads traces to OpenAI; this processor replaces
it. Spans are stored with names, kinds, timings and sizes only — never
prompts, arguments or outputs — and exported as OpenTelemetry-shaped JSON
from ``GET /tasks/{id}/trace``.
"""

from __future__ import annotations

import json
import threading
from typing import Any

from .. import db

_SAFE_ATTRS = {
    "agent": ("name",),
    "function": ("name",),
    "generation": ("model",),
    "response": (),
    "guardrail": ("name", "triggered"),
    "handoff": ("from_agent", "to_agent"),
    "custom": ("name",),
    "mcp_tools": ("server",),
}


class LocalProcessor:
    def __init__(self) -> None:
        self._traces: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def on_trace_start(self, trace: Any) -> None:
        meta = {}
        try:
            meta = dict(getattr(trace, "metadata", None) or {})
        except Exception:  # noqa: BLE001
            pass
        with self._lock:
            self._traces[trace.trace_id] = meta

    def on_trace_end(self, trace: Any) -> None:
        with self._lock:
            self._traces.pop(trace.trace_id, None)

    def on_span_start(self, span: Any) -> None:
        return None

    def on_span_end(self, span: Any) -> None:
        try:
            data = span.span_data
            kind = getattr(data, "type", "custom")
            exported = data.export() if hasattr(data, "export") else {}
            attrs = {k: exported.get(k) for k in _SAFE_ATTRS.get(kind, ()) if exported.get(k) is not None}
            usage = exported.get("usage") if isinstance(exported.get("usage"), dict) else None
            if usage:
                attrs["usage"] = {k: v for k, v in usage.items() if isinstance(v, int)}
            name = str(attrs.get("name") or attrs.get("model") or kind)[:120]
            with self._lock:
                meta = self._traces.get(span.trace_id, {})
            err = getattr(span, "error", None)
            conn = db.connect()
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO spans (id, trace_id, parent_id, task_id, turn_id, kind, name, "
                    "started_at, ended_at, error, attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (span.span_id, span.trace_id, span.parent_id, meta.get("task_id"), meta.get("turn_id"),
                     kind, name, span.started_at, span.ended_at,
                     (str(err.get("message") if isinstance(err, dict) else err)[:300] if err else None),
                     json.dumps(attrs, default=str)))
                conn.commit()
            finally:
                conn.close()
        except Exception:  # noqa: BLE001 — tracing never fails a turn
            pass

    def shutdown(self) -> None:
        return None

    def force_flush(self) -> None:
        return None


_installed = False


def install() -> None:
    """Replace the SDK's uploading exporter with the local processor (once)."""
    global _installed
    if _installed:
        return
    from agents import set_trace_processors
    set_trace_processors([LocalProcessor()])
    _installed = True


def otel_export(conn: Any, task_id: str) -> dict[str, Any]:
    """The task's spans as an OTLP-shaped JSON document."""
    rows = conn.execute("SELECT * FROM spans WHERE task_id = ? ORDER BY started_at", (task_id,)).fetchall()
    spans = []
    for r in rows:
        spans.append({
            "traceId": r["trace_id"].replace("trace_", "")[:32].ljust(32, "0"),
            "spanId": r["id"].replace("span_", "")[:16].ljust(16, "0"),
            "parentSpanId": (r["parent_id"] or "").replace("span_", "")[:16] or None,
            "name": r["name"],
            "kind": r["kind"],
            "startTime": r["started_at"],
            "endTime": r["ended_at"],
            "status": {"code": "ERROR", "message": r["error"]} if r["error"] else {"code": "OK"},
            "attributes": {"storage_agent.turn_id": r["turn_id"], **json.loads(r["attributes"] or "{}")},
        })
    return {"resourceSpans": [{"resource": {"attributes": {"service.name": "storage-agent",
                                                           "storage_agent.task_id": task_id}},
                               "scopeSpans": [{"scope": {"name": "openai-agents"}, "spans": spans}]}]}
