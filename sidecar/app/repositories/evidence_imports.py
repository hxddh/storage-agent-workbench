"""Managed evidence-import repository.

Records bounded, confirmation-gated imports of evidence files (inventory /
access logs) discovered by account_discovery. Bucket / prefix / object key and
warnings are redaction-passed before storage — never AK/SK/session token/
Authorization/cookies/presigned URL/model key.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from ..security.redaction import redact_text
from . import utcnow


def _r(value: Any) -> str | None:
    if value is None:
        return None
    return redact_text(str(value))


def create_plan(
    conn: sqlite3.Connection,
    *,
    provider_id: str | None,
    account_run_id: str | None,
    snapshot_id: str | None,
    source_type: str,
    source_bucket: str | None,
    source_prefix: str | None,
    evidence_ref: str | None,
    fmt: str | None,
    fmt_schema: str | None,
    plan_source: str | None,
    max_files: int,
    max_bytes: int,
    time_range_start: str | None,
    time_range_end: str | None,
    planned_file_count: int,
    planned_total_bytes: int,
    selected_file_count: int,
    selected_total_bytes: int,
    warnings: list[str],
    files: list[dict[str, Any]],
) -> str:
    import_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO evidence_imports "
        "(id, provider_id, account_run_id, snapshot_id, source_type, source_bucket, "
        " source_prefix, evidence_ref, format, fmt_schema, plan_source, max_files, max_bytes, "
        " time_range_start, time_range_end, planned_file_count, planned_total_bytes, "
        " selected_file_count, selected_total_bytes, status, warnings_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)",
        (
            import_id, provider_id, account_run_id, snapshot_id, source_type,
            _r(source_bucket), _r(source_prefix), _r(evidence_ref), fmt, fmt_schema, plan_source,
            int(max_files), int(max_bytes), time_range_start, time_range_end,
            int(planned_file_count), int(planned_total_bytes),
            int(selected_file_count), int(selected_total_bytes),
            json.dumps([_r(w) for w in (warnings or [])]), utcnow(),
        ),
    )
    for f in files:
        conn.execute(
            "INSERT INTO evidence_import_files "
            "(id, import_id, object_key, size_bytes, kind, selected, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)",
            (uuid.uuid4().hex, import_id, _r(f.get("key")), int(f.get("size") or 0),
             f.get("kind") or "data", 1 if f.get("selected") else 0, utcnow()),
        )
    conn.commit()
    return import_id


def get(conn: sqlite3.Connection, import_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM evidence_imports WHERE id = ?", (import_id,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["warnings"] = json.loads(data.get("warnings_json") or "[]")
    data["files"] = [
        {
            "object_key": f["object_key"],
            "size_bytes": f["size_bytes"],
            "kind": f["kind"],
            "selected": bool(f["selected"]),
            "status": f["status"],
        }
        for f in conn.execute(
            "SELECT * FROM evidence_import_files WHERE import_id = ? ORDER BY rowid", (import_id,)
        ).fetchall()
    ]
    return data


def selected_files(conn: sqlite3.Connection, import_id: str) -> list[dict[str, Any]]:
    return [
        {"object_key": f["object_key"], "size_bytes": f["size_bytes"], "kind": f["kind"]}
        for f in conn.execute(
            "SELECT * FROM evidence_import_files WHERE import_id = ? AND selected = 1 ORDER BY rowid",
            (import_id,),
        ).fetchall()
    ]


def set_status(conn: sqlite3.Connection, import_id: str, status: str, **fields: Any) -> None:
    sets = ["status = ?"]
    params: list[Any] = [status]
    if status == "confirmed":
        sets.append("confirmed_at = ?")
        params.append(utcnow())
    for key in ("analysis_run_id",):
        if key in fields and fields[key] is not None:
            sets.append(f"{key} = ?")
            params.append(fields[key])
    params.append(import_id)
    conn.execute(f"UPDATE evidence_imports SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()


def mark_files(conn: sqlite3.Connection, import_id: str, status: str) -> None:
    conn.execute(
        "UPDATE evidence_import_files SET status = ? WHERE import_id = ? AND selected = 1",
        (status, import_id),
    )
    conn.commit()
