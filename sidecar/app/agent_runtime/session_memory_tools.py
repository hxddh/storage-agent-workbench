"""Working-memory tools for the in-chat agent (Round A).

These let the agent persist what it learns *itself*, so its discoveries survive
across turns instead of evaporating when the prompt window rolls (only the last
N messages are replayed) or being wiped by the deterministic summary rebuild.

The agent records three kinds of item into durable, per-session memory:

- ``note_fact`` — a grounded fact it established (e.g. "bucket X is path-style
  only"), optionally with a confidence;
- ``record_finding`` — a notable issue/observation, with a severity;
- ``note_open_question`` — something still unresolved to revisit.

Each item is REDACTED before storage (no secrets, no raw rows — same as every
other agent output), AUDITED, and fed back into the next turn's context as
``agent_memory`` (see ``session_agent.build_session_context``). These tools are
always available regardless of the autonomy policy: recording an observation is
read-only with respect to the cloud and never mutates anything there.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Callable

from .. import audit
from ..repositories import sessions as sessions_repo
from ..security.redaction import redact_text

_SEVERITIES = {"info", "low", "medium", "high", "critical"}
_CONFIDENCES = {"low", "medium", "high"}


def build(
    conn: sqlite3.Connection,
    function_tool: Callable,
    session_id: str | None,
    activity: list[dict[str, Any]] | None = None,
) -> list[Any]:
    """Build the memory tools bound to this session. Empty if no session."""
    if conn is None or not session_id:
        return []

    def note(tool: str, target: str) -> None:
        if activity is not None:
            activity.append({"tool": tool, "target": target[:80], "result": "recorded"})

    def _norm(value: str | None, allowed: set[str]) -> str | None:
        v = (value or "").strip().lower()
        return v if v in allowed else None

    @function_tool
    def note_fact(text: str, confidence: str = "medium") -> str:
        """Record a grounded fact you established during this investigation so it persists for later turns (it is shown back to you next time as agent_memory). Use for durable, tool-verified facts (e.g. 'bucket acme-logs is path-style only'). Args: text; confidence (low|medium|high)."""
        mem_id = sessions_repo.add_agent_memory(
            conn, session_id, "fact", text, confidence=_norm(confidence, _CONFIDENCES))
        audit.record(conn, "session_memory", {"kind": "fact", "text": redact_text(text)[:200]}, run_id=None)
        note("note_fact", text)
        return json.dumps({"ok": True, "id": mem_id, "kind": "fact"})

    @function_tool
    def record_finding(title: str, severity: str = "info") -> str:
        """Record a notable finding/issue so it persists across turns and shows up in this session's memory. Use for problems or noteworthy observations (e.g. 'bucket is world-readable'). Args: title; severity (info|low|medium|high|critical)."""
        mem_id = sessions_repo.add_agent_memory(
            conn, session_id, "finding", title, severity=_norm(severity, _SEVERITIES) or "info")
        audit.record(conn, "session_memory", {"kind": "finding", "text": redact_text(title)[:200]}, run_id=None)
        note("record_finding", title)
        return json.dumps({"ok": True, "id": mem_id, "kind": "finding"})

    @function_tool
    def note_open_question(text: str) -> str:
        """Record an unresolved question to revisit later in this session. Use when something needs more evidence or a user decision. Args: text."""
        mem_id = sessions_repo.add_agent_memory(conn, session_id, "open_question", text)
        audit.record(conn, "session_memory", {"kind": "open_question", "text": redact_text(text)[:200]}, run_id=None)
        note("note_open_question", text)
        return json.dumps({"ok": True, "id": mem_id, "kind": "open_question"})

    return [note_fact, record_finding, note_open_question]
