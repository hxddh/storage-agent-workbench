"""Execute a tool and persist a sanitized record of the call.

Every tool invocation writes one ``tool_calls`` row and one ``audit_logs`` row.
Both the recorded input and output are passed through the redaction utility, so
even if a tool result ever contained a credential-shaped value it would be
masked before persistence. Tool inputs here only carry public parameters
(provider_id, bucket, key, ...); secrets are resolved internally from the
keyring and never appear in the input dict.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from collections.abc import Callable
from typing import Any

from . import audit
from .security.redaction import redact


def run_tool(
    conn: sqlite3.Connection,
    tool_name: str,
    raw_input: dict[str, Any],
    executor: Callable[[], dict[str, Any]],
    run_id: str | None = None,
) -> dict[str, Any]:
    """Run ``executor``, record a sanitized tool_call + audit entry, return output."""
    started = time.monotonic()
    try:
        output = executor()
        status = "success" if output.get("success", True) else "error"
    except Exception as exc:  # noqa: BLE001 - failures are recorded, sanitized
        output = {
            "success": False,
            "error_code": type(exc).__name__,
            "error_message_sanitized": redact(str(exc)),
        }
        status = "error"

    duration_ms = int((time.monotonic() - started) * 1000)
    sanitized_input = redact(raw_input)
    sanitized_output = redact(output)

    conn.execute(
        "INSERT INTO tool_calls "
        "(id, run_id, tool_name, input_json_sanitized, output_json_sanitized, "
        " status, duration_ms, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
        (
            uuid.uuid4().hex,
            run_id,
            tool_name,
            json.dumps(sanitized_input),
            json.dumps(sanitized_output),
            status,
            duration_ms,
        ),
    )
    audit.record(
        conn,
        f"tool.{tool_name}",
        {"input": sanitized_input, "status": status},
        run_id=run_id,
    )
    conn.commit()
    return output
