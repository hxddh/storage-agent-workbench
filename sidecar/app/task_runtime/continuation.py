"""v2.2 — a continuation picks up where the stopped execution left off.

A ``kind=resume`` (interrupted) or ``kind=retry`` (cancelled) execution stores
the user's Direction exactly as written; the continuation note and a bounded
digest of the calls that already completed are added only to the MODEL's copy
of the Direction at run time. So the Task document never shows a runtime note
as the user's words, and the model does not re-run read-only calls whose
one-line results it already has.

The digest is built from the durable ``tool.completed`` events of the stopped
execution (and at most two earlier links of its chain) — sanitized payloads
that were already bounded when they were written. No raw rows, no outputs
beyond the one-line result the Execution log keeps.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from ..security.redaction import redact_text
from . import store

CONTINUATION_KINDS = ("resume", "retry")
# Pre-2.2 continuations carried the note inside the stored Direction.
_LEGACY_NOTE = re.compile(
    r"\n\n\[(?:resume|retry)\] The previous execution of this direction was .*\Z", re.S)

_MAX_CHAIN = 3
_MAX_LINES = 24
_MAX_RESULT = 160
_MAX_DIGEST = 2400


def clean_direction(text: str | None) -> str:
    """The user's Direction without any (legacy) continuation note."""
    return _LEGACY_NOTE.sub("", text or "")


def completed_calls_digest(conn: sqlite3.Connection, execution_id: str) -> str:
    """One line per call that completed in the stopped execution (and its
    chain), oldest first, bounded in lines and characters."""
    chain: list[str] = []
    seen: set[str] = set()
    current: str | None = execution_id
    while current and current not in seen and len(chain) < _MAX_CHAIN:
        seen.add(current)
        chain.append(current)
        row = store.get_execution(conn, current)
        current = (row or {}).get("resumed_from")
    lines: list[str] = []
    for exec_id in reversed(chain):
        for event in store.list_events(conn, exec_id, limit=2000):
            if event["event_type"] != "tool.completed":
                continue
            payload = event.get("payload") or {}
            tool = str(payload.get("tool") or "").strip()
            if not tool:
                continue
            target = str(payload.get("target") or "").strip()
            result = " ".join(str(payload.get("result") or "").split())[:_MAX_RESULT]
            mark = "" if payload.get("ok", True) is not False else " (failed)"
            head = f"{tool} {target}".strip()
            lines.append(f"- {head}{mark}" + (f" → {result}" if result else ""))
    if not lines:
        return ""
    # The most recent calls matter most: bound by lines, then by characters,
    # always dropping the OLDEST and saying how many were left out.
    total = len(lines)
    lines = lines[-_MAX_LINES:]
    while len(lines) > 1 and sum(len(line) + 1 for line in lines) + 48 > _MAX_DIGEST:
        lines.pop(0)
    dropped = total - len(lines)
    if dropped:
        lines.insert(0, f"- … {dropped} earlier call(s) not listed")
    return redact_text("\n".join(lines))[:_MAX_DIGEST]


def prompt_direction(conn: sqlite3.Connection, execution: dict[str, Any]) -> str:
    """The Direction as the model receives it: the user's words, plus — for a
    continuation — what happened and what already completed."""
    direction = execution.get("direction") or ""
    kind = execution.get("kind")
    source = execution.get("resumed_from")
    if kind not in CONTINUATION_KINDS or not source:
        return direction
    previous = store.get_execution(conn, source)
    was = (previous or {}).get("status") or "interrupted"
    note = (f"\n\n[{kind}] The previous execution of this direction was {was} "
            "before it could finish. Continue from what the task has already "
            "established; do not start over.")
    digest = completed_calls_digest(conn, source)
    if digest:
        note += ("\nCalls that already completed before it stopped (one-line "
                 "results — reuse them; repeat a call only when you need detail "
                 "its line does not carry):\n" + digest)
    return clean_direction(direction) + note
