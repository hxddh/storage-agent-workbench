"""Account-discovery result repository.

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


def recent_run_ids_for_provider(
    conn: sqlite3.Connection, provider_id: str, limit: int = 2
) -> list[str]:
    """The run_ids of a provider's most recent COMPLETED account snapshots, newest
    first — across sessions (the account is the same account). Used to diff 'what
    changed since last time' and to answer cross-bucket posture.

    Only ``runs.status = 'completed'`` snapshots are returned: ``create_snapshot``
    commits the snapshot row (with ``processed_count`` = the full selection) BEFORE
    the per-bucket loop, so a run that crashed/was killed mid-survey leaves a
    snapshot with only k of N bucket rows. Surfacing that as the newest survey made
    ``compare_to_last_survey`` report the un-scanned buckets as 'removed' and
    ``query_account_profile`` answer posture from a truncated set. Joining on the
    run's terminal status excludes those partials."""
    rows = conn.execute(
        "SELECT s.run_id FROM account_snapshots s "
        "JOIN runs r ON r.id = s.run_id "
        "WHERE s.provider_id = ? AND r.status = 'completed' "
        "ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?",
        (provider_id, max(1, int(limit))),
    ).fetchall()
    return [r["run_id"] for r in rows]


# Scalar per-bucket aspects the diff compares (all already-sanitized status/enum/
# bool fields from the config snapshot + the bucket access status).
_DIFF_ASPECTS = (
    "access_status", "region", "head_bucket_status",
    "versioning_status", "versioning_enabled", "encryption_status",
    "lifecycle_status", "logging_status", "logging_enabled",
    # Public posture: the diff's most valuable alert — a bucket whose
    # policy_is_public/publicly_exposed flipped False→True BECAME PUBLIC.
    "policy_is_public", "policy_public_status", "object_ownership", "acls_disabled",
    "acl_public", "publicly_exposed",
    "replication_status", "policy_status", "public_access_block_status",
    "tagging_status", "inventory_status",
)
_MAX_DIFF_CHANGES = 200


def _scalar(v: Any) -> Any:
    """A short, safe representation of a scalar aspect value for the diff."""
    if v is None or isinstance(v, bool):
        return v
    return str(v)[:80]


def _evidence_map(bucket: dict[str, Any]) -> dict[str, Any]:
    return {e.get("source_type"): e.get("status")
            for e in (bucket.get("evidence_sources") or []) if e.get("source_type")}


def diff_profiles(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """Deterministic diff of two account profiles (as returned by get_profile):
    buckets added/removed, per-bucket config-aspect changes, and evidence-source
    changes. Pure function — no LLM, no S3, no raw object listings; it reads only
    the already-persisted, already-sanitized profile facts. Bounded output."""
    old_b = {b["bucket_name"]: b for b in (old.get("buckets") or [])}
    new_b = {b["bucket_name"]: b for b in (new.get("buckets") or [])}
    changes: list[dict[str, Any]] = []
    for name in sorted(set(new_b) - set(old_b)):
        changes.append({"bucket": name, "change": "bucket_added"})
    for name in sorted(set(old_b) - set(new_b)):
        changes.append({"bucket": name, "change": "bucket_removed"})
    baselined: set[str] = set()
    for name in sorted(set(old_b) & set(new_b)):
        ob, nb = old_b[name], new_b[name]
        for k in _DIFF_ASPECTS:
            if k in ob or k in nb:
                # An aspect the OLD survey never recorded (schema grew, e.g. the
                # v0.29 public-posture flags) is a BASELINE, not a change — on a
                # 60+ bucket account the None→value noise alone blew past the
                # change cap and could truncate a real "became public". Report
                # it once as a baselined field; the NEXT diff catches real flips.
                if k not in ob:
                    baselined.add(k)
                    continue
                ov, nv = ob.get(k), nb.get(k)
                if ov != nv:
                    entry: dict[str, Any] = {"bucket": name, "change": k,
                                             "from": _scalar(ov), "to": _scalar(nv)}
                    # Make security-relevant flips unmissable for the narrator.
                    if k in ("policy_is_public", "publicly_exposed", "acl_public") and nv is True:
                        entry["alert"] = True
                        entry["note"] = "bucket BECAME PUBLIC since the last survey"
                    changes.append(entry)
        oe, ne = _evidence_map(ob), _evidence_map(nb)
        for st in sorted(set(oe) | set(ne)):
            if oe.get(st) != ne.get(st):
                changes.append({"bucket": name, "change": f"evidence:{st}",
                                "from": _scalar(oe.get(st)), "to": _scalar(ne.get(st))})
    # Alerts first, so truncation can never cut a became-public signal.
    changes.sort(key=lambda c: not c.get("alert", False))
    out: dict[str, Any] = {
        "changes": changes[:_MAX_DIFF_CHANGES],
        "change_count": len(changes),
        "truncated": len(changes) > _MAX_DIFF_CHANGES,
    }
    if baselined:
        out["fields_baselined"] = sorted(baselined)
        out["note"] = ("Some posture fields exist only in the newer survey (app upgrade); "
                       "they were baselined, not reported as changes. The next survey diff "
                       "will track them normally.")
    return out
