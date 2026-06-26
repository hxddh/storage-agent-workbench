"""Account-discovery result repository (Phase 14).

Persists the account-level asset picture produced by an ``account_discovery``
run across four tables (account_snapshots, account_snapshot_buckets,
bucket_config_snapshots, evidence_sources). Every JSON payload is passed through
the redaction utility before insertion, so AK/SK/session tokens/Authorization
headers/cookies/presigned URLs/model keys can never land in SQLite even if a
sanitized tool output somehow carried one. No raw object listings, no raw
inventory/log content — only bucket-level facts and evidence-source metadata.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from ..security.redaction import redact
from . import utcnow


def _dumps(value: Any) -> str:
    return json.dumps(redact(value), default=str)


def create_snapshot(
    conn: sqlite3.Connection,
    run_id: str,
    provider_id: str | None,
    *,
    bucket_count: int,
    visible_count: int,
    processed_count: int,
    truncated: bool,
    list_status: str,
    summary: dict[str, Any],
) -> str:
    snapshot_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO account_snapshots "
        "(id, run_id, provider_id, bucket_count, visible_count, processed_count, "
        " truncated, list_status, summary_json_sanitized, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            snapshot_id,
            run_id,
            provider_id,
            int(bucket_count),
            int(visible_count),
            int(processed_count),
            1 if truncated else 0,
            list_status,
            _dumps(summary),
            utcnow(),
        ),
    )
    conn.commit()
    return snapshot_id


def add_bucket(
    conn: sqlite3.Connection,
    snapshot_id: str,
    run_id: str,
    provider_id: str | None,
    bucket_name: str,
    region: str | None,
    access_status: str,
) -> str:
    row_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO account_snapshot_buckets "
        "(id, snapshot_id, run_id, provider_id, bucket_name, region, access_status, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (row_id, snapshot_id, run_id, provider_id, bucket_name, region, access_status, utcnow()),
    )
    return row_id


def add_config_snapshot(
    conn: sqlite3.Connection,
    snapshot_id: str,
    run_id: str,
    provider_id: str | None,
    bucket_name: str,
    config_summary: dict[str, Any],
) -> None:
    conn.execute(
        "INSERT INTO bucket_config_snapshots "
        "(id, snapshot_id, run_id, provider_id, bucket_name, config_summary_json_sanitized, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (uuid.uuid4().hex, snapshot_id, run_id, provider_id, bucket_name,
         _dumps(config_summary), utcnow()),
    )


def add_evidence_source(
    conn: sqlite3.Connection,
    snapshot_id: str,
    run_id: str,
    provider_id: str | None,
    bucket_name: str,
    source: dict[str, Any],
) -> None:
    conn.execute(
        "INSERT INTO evidence_sources "
        "(id, snapshot_id, run_id, provider_id, bucket_name, source_type, status, "
        " detail_json_sanitized, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (uuid.uuid4().hex, snapshot_id, run_id, provider_id, bucket_name,
         source.get("source_type"), source.get("status"), _dumps(source), utcnow()),
    )


def get_profile(conn: sqlite3.Connection, run_id: str) -> dict[str, Any] | None:
    """Reconstruct the account profile for a run from the persisted tables."""
    snap = conn.execute(
        "SELECT * FROM account_snapshots WHERE run_id = ? "
        "ORDER BY created_at DESC, rowid DESC LIMIT 1",
        (run_id,),
    ).fetchone()
    if snap is None:
        return None
    sid = snap["id"]

    buckets: list[dict[str, Any]] = []
    for b in conn.execute(
        "SELECT * FROM account_snapshot_buckets WHERE snapshot_id = ? ORDER BY rowid",
        (sid,),
    ).fetchall():
        name = b["bucket_name"]
        cfg_row = conn.execute(
            "SELECT config_summary_json_sanitized FROM bucket_config_snapshots "
            "WHERE snapshot_id = ? AND bucket_name = ? ORDER BY rowid DESC LIMIT 1",
            (sid, name),
        ).fetchone()
        cfg = json.loads(cfg_row[0]) if cfg_row and cfg_row[0] else {}

        evidence: list[dict[str, Any]] = []
        for e in conn.execute(
            "SELECT * FROM evidence_sources WHERE snapshot_id = ? AND bucket_name = ? ORDER BY rowid",
            (sid, name),
        ).fetchall():
            detail = json.loads(e["detail_json_sanitized"]) if e["detail_json_sanitized"] else {}
            evidence.append({
                "source_type": e["source_type"],
                "status": e["status"],
                "configured": detail.get("configured"),
                "detail": detail,
            })

        buckets.append({
            **cfg,
            "bucket_name": name,
            "region": b["region"],
            "access_status": b["access_status"],
            "evidence_sources": evidence,
        })

    summary = json.loads(snap["summary_json_sanitized"]) if snap["summary_json_sanitized"] else {}
    return {
        "run_id": run_id,
        "provider_id": snap["provider_id"],
        "bucket_count": snap["bucket_count"],
        "visible_count": snap["visible_count"],
        "processed_count": snap["processed_count"],
        "truncated": bool(snap["truncated"]),
        "list_status": snap["list_status"],
        "summary": summary,
        "buckets": buckets,
        "created_at": snap["created_at"],
    }
