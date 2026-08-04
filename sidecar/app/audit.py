"""Audit logging.

Every provider mutation (and, in later phases, tool calls / approvals / report
generation) is recorded in ``audit_logs``. Payloads are redacted before
insertion so secrets never reach the audit trail.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from .repositories import utcnow
from .security.redaction import redact


def record(
    conn: sqlite3.Connection,
    event_type: str,
    payload: dict[str, Any] | None = None,
    run_id: str | None = None,
    session_id: str | None = None,
) -> None:
    """Insert a redacted audit-log entry. Does not commit.

    created_at uses the repositories' ISO-8601 UTC "Z" format (not SQLite's
    ``datetime('now')``) so audit rows string-sort coherently with every other
    table.

    ``session_id`` is what makes a conversational turn's trail readable back.
    Rule 17 always required recording these events, and they were — but a turn
    has no run, so every session event landed with both ids NULL and no view
    could ever retrieve it for the session it belonged to.
    """
    safe = redact(payload or {})
    conn.execute(
        "INSERT INTO audit_logs (id, run_id, session_id, event_type, "
        " payload_json_sanitized, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (uuid.uuid4().hex, run_id, session_id, event_type, json.dumps(safe), utcnow()),
    )
