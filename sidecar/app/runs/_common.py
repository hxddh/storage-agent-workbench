"""Shared helpers for run executors."""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Callable
from typing import Any

from ..events import bus
from ..tool_runner import run_tool


def run_tool_with_events(
    conn: sqlite3.Connection,
    run_id: str,
    name: str,
    raw_input: dict[str, Any],
    executor: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    """Publish started/finished SSE events around a recorded tool call."""
    tool_call_id = uuid.uuid4().hex
    bus.publish(run_id, {"type": "tool_call_started", "tool_name": name, "tool_call_id": tool_call_id})
    out = run_tool(conn, name, raw_input, executor, run_id=run_id)
    status = "success" if out.get("success", True) else "error"
    bus.publish(run_id, {
        "type": "tool_call_finished",
        "tool_name": name,
        "tool_call_id": tool_call_id,
        "status": status,
        "output": out,
    })
    return out


class RunError(Exception):
    """Raised when a run cannot proceed (e.g. missing dataset)."""
