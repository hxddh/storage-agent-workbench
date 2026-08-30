"""Versioned Task baselines and deterministic Drift reports.

A baseline is a bounded aggregate snapshot (inventory overview, config facts,
findings, context version) — never raw inventory/log rows. Drift is a three-way
finding classification plus config diffs. No baseline → an explicit gap, never
a fabricated trend.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from ..repositories import utcnow
from ..security.redaction import redact, redact_text
from ..task_runtime import artifacts as task_artifacts
from ..task_runtime import store

_MAX_FINDINGS = 40
_MAX_DIFF = 40


def _new_id() -> str:
    return uuid.uuid4().hex


def _dumps(value: Any) -> str:
    return json.dumps(redact(value), default=str, ensure_ascii=False)


def _loads(raw: Any, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return fallback
    return data


def _clip_findings(findings: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in findings or []:
        if not isinstance(item, dict):
            continue
        title = redact_text(str(item.get("title") or ""))[:200]
        if not title:
            continue
        out.append({
            "title": title,
            "severity": redact_text(str(item.get("severity") or item.get("category") or "info"))[:40],
            "category": redact_text(str(item.get("category") or ""))[:40],
        })
        if len(out) >= _MAX_FINDINGS:
            break
    return out


def snapshot(*,
             inventory: dict[str, Any] | None = None,
             lifecycle: dict[str, Any] | None = None,
             config: dict[str, Any] | None = None,
             findings: list[dict[str, Any]] | None = None,
             context_version: int | None = None) -> dict[str, Any]:
    inv = inventory if isinstance(inventory, dict) else {}
    facts = {}
    if isinstance(lifecycle, dict):
        facts = lifecycle.get("facts") or lifecycle
    cfg = config if isinstance(config, dict) else {}
    return {
        "inventory": {
            "object_count": int(inv.get("object_count") or 0),
            "total_size": int(inv.get("total_size") or 0),
            "unknown_age_ratio": inv.get("unknown_age_ratio"),
            "unknown_size_ratio": inv.get("unknown_size_ratio"),
            "storage_class_distribution": (inv.get("storage_class_distribution") or [])[:15],
            "object_age_distribution": (inv.get("object_age_distribution") or [])[:12],
            "as_of": inv.get("as_of") or inv.get("captured_at"),
        } if inv else None,
        "lifecycle_facts": {
            k: facts.get(k) for k in (
                "lifecycle_status", "has_rules", "has_abort_mpu", "has_expiration",
                "has_transition", "has_noncurrent_expiration", "versioning_enabled",
            ) if k in (facts or {})
        } or None,
        "config": {k: cfg.get(k) for k in list(cfg)[:20]} if cfg else None,
        "findings": _clip_findings(findings),
        "context_version": context_version,
    }


def capture(conn: sqlite3.Connection, task_id: str, snap: dict[str, Any], *,
            execution_id: str | None = None,
            context_version: int | None = None) -> dict[str, Any]:
    now = utcnow()
    version = int((conn.execute(
        "SELECT COALESCE(MAX(version), 0) FROM task_baselines WHERE task_id = ?",
        (task_id,),
    ).fetchone()[0])) + 1
    bid = _new_id()
    ctx = context_version
    if ctx is None:
        latest_ctx = store.latest_context(conn, task_id)
        ctx = int(latest_ctx["version"]) if latest_ctx else None
    conn.execute(
        "INSERT INTO task_baselines (id, task_id, execution_id, version, "
        "snapshot_json_sanitized, context_version, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (bid, task_id, execution_id, version, _dumps(snap), ctx, now),
    )
    task_artifacts.record_baseline(
        conn, task_id, bid,
        title=f"Baseline v{version}",
        execution_id=execution_id,
        summary="Bounded inventory/config/findings snapshot",
    )
    conn.commit()
    return get(conn, bid)  # type: ignore[return-value]


def get(conn: sqlite3.Connection, baseline_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM task_baselines WHERE id = ?", (baseline_id,),
    ).fetchone()
    return _row(row) if row else None


def latest(conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM task_baselines WHERE task_id = ? "
        "ORDER BY version DESC LIMIT 1", (task_id,),
    ).fetchone()
    return _row(row) if row else None


def list_baselines(conn: sqlite3.Connection, task_id: str,
                   limit: int = 20) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM task_baselines WHERE task_id = ? "
        "ORDER BY version DESC LIMIT ?",
        (task_id, max(1, int(limit))),
    ).fetchall()
    return [_row(r) for r in rows]


def _row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "execution_id": row["execution_id"],
        "version": row["version"],
        "snapshot": _loads(row["snapshot_json_sanitized"], {}),
        "context_version": row["context_version"],
        "created_at": row["created_at"],
    }


def _finding_key(item: dict[str, Any]) -> str:
    return str(item.get("title") or "").strip().lower()


def _config_diff(old: dict[str, Any] | None,
                 new: dict[str, Any] | None) -> list[dict[str, Any]]:
    old = old or {}
    new = new or {}
    keys = sorted(set(old) | set(new))
    diffs: list[dict[str, Any]] = []
    for key in keys:
        if old.get(key) != new.get(key):
            diffs.append({
                "key": redact_text(str(key))[:80],
                "before": old.get(key),
                "after": new.get(key),
            })
        if len(diffs) >= _MAX_DIFF:
            break
    return diffs


def _inventory_trend(old: dict[str, Any] | None,
                     new: dict[str, Any] | None) -> dict[str, Any] | None:
    if not old or not new:
        return None
    return {
        "object_count_delta": int(new.get("object_count") or 0) - int(old.get("object_count") or 0),
        "total_size_delta": int(new.get("total_size") or 0) - int(old.get("total_size") or 0),
        "points": 2,
        "note": "Direction from two snapshots only; not a forecast.",
        "estimate": True,
    }


def compare(previous: dict[str, Any] | None,
            current: dict[str, Any]) -> dict[str, Any]:
    if previous is None:
        return {
            "kind": "gap",
            "code": "no_baseline",
            "message": "No comparable baseline exists for this Task yet. "
                       "Capture a baseline before asking for Drift.",
            "findings": {"added": [], "resolved": [], "still_present": []},
            "config_diff": [],
            "inventory_trend": None,
        }
    prev_snap = previous.get("snapshot") if "snapshot" in previous else previous
    curr_snap = current.get("snapshot") if "snapshot" in current else current
    prev_findings = {_finding_key(f): f for f in (prev_snap.get("findings") or [])}
    curr_findings = {_finding_key(f): f for f in (curr_snap.get("findings") or [])}
    added = [curr_findings[k] for k in curr_findings if k and k not in prev_findings]
    resolved = [prev_findings[k] for k in prev_findings if k and k not in curr_findings]
    still = [curr_findings[k] for k in curr_findings if k and k in prev_findings]
    life_old = prev_snap.get("lifecycle_facts") or prev_snap.get("config")
    life_new = curr_snap.get("lifecycle_facts") or curr_snap.get("config")
    return {
        "kind": "drift",
        "baseline_id": previous.get("id"),
        "baseline_version": previous.get("version"),
        "baseline_created_at": previous.get("created_at"),
        "config_diff": _config_diff(life_old, life_new),
        "inventory_trend": _inventory_trend(prev_snap.get("inventory"), curr_snap.get("inventory")),
        "findings": {
            "added": added[:_MAX_FINDINGS],
            "resolved": resolved[:_MAX_FINDINGS],
            "still_present": still[:_MAX_FINDINGS],
        },
        "estimate": True,
    }


def record_drift_artifact(conn: sqlite3.Connection, task_id: str,
                          report: dict[str, Any], *,
                          execution_id: str | None = None) -> str | None:
    title = "Drift report" if report.get("kind") == "drift" else "Drift report (no baseline)"
    summary = report.get("message") if report.get("kind") == "gap" else (
        f"added {len((report.get('findings') or {}).get('added') or [])}, "
        f"resolved {len((report.get('findings') or {}).get('resolved') or [])}, "
        f"still {len((report.get('findings') or {}).get('still_present') or [])}"
    )
    return task_artifacts.record_drift_report(
        conn, task_id, title=title, execution_id=execution_id, summary=summary,
        payload=report,
    )
