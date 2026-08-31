"""Read-only provenance projection for findings, figures, and analysis documents.

No new tables. The chain is assembled from session_findings, tool_calls,
task_artifacts, and runs that already exist. A missing link is an explicit
``no_direct_evidence`` gap — never a fabricated source.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..security.redaction import redact_text

_MAX_FINDINGS = 40
_PREVIEW = 240

COST_TOOLS = ("simulate_storage_cost",)
INVENTORY_TOOLS = ("analyze_uploaded_file", "analyze_inventory")
ACCESS_LOG_TOOLS = ("analyze_uploaded_file", "analyze_access_logs")
DRIFT_TOOLS = ("compare_task_drift",)


def _load(raw: Any) -> dict[str, Any] | None:
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _clip(value: Any, n: int = _PREVIEW) -> str:
    return redact_text(str(value or ""))[:n]


def _latest_tool(conn: sqlite3.Connection, task_id: str, names: tuple[str, ...],
                 *, kind: str | None = None) -> dict[str, Any] | None:
    placeholders = ",".join("?" * len(names))
    rows = conn.execute(
        "SELECT id, tool_name, output_json_sanitized, created_at, run_id "
        f"FROM tool_calls WHERE session_id = ? AND tool_name IN ({placeholders}) "
        "ORDER BY created_at DESC, rowid DESC LIMIT 12",
        (task_id, *names),
    ).fetchall()
    for row in rows:
        payload = _load(row["output_json_sanitized"])
        if not payload or payload.get("error"):
            continue
        if kind and not _matches_kind(payload, kind):
            continue
        return {
            "call_id": row["id"],
            "tool": row["tool_name"],
            "run_id": row["run_id"],
            "created_at": row["created_at"],
            "output": payload,
        }
    return None


def _matches_kind(payload: dict[str, Any], kind: str) -> bool:
    ptype = payload.get("type")
    if ptype:
        return ptype == kind
    inner = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else payload
    if kind == "inventory":
        return "object_count" in inner or "storage_class_distribution" in inner
    if kind == "access_log":
        return "total_requests" in inner or "method_distribution" in inner
    return payload.get("kind") == kind


def _unwrap_metrics(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not payload:
        return None
    metrics = payload.get("metrics")
    if isinstance(metrics, dict):
        return metrics
    return payload


def _coverage_from(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not payload:
        return None
    coverage = payload.get("coverage")
    if isinstance(coverage, dict):
        return {
            "object_count": coverage.get("object_count"),
            "bytes": coverage.get("bytes"),
            "inventory_as_of": coverage.get("inventory_as_of"),
            "unknown_age_ratio": coverage.get("unknown_age_ratio"),
            "unknown_size_ratio": coverage.get("unknown_size_ratio"),
            "note": _clip(coverage.get("note"), 400) if coverage.get("note") else None,
            "truncated": bool(payload.get("truncated")),
        }
    metrics = _unwrap_metrics(payload) or {}
    if "object_count" in metrics or "total_requests" in metrics or "unknown_age_ratio" in metrics:
        return {
            "object_count": metrics.get("object_count"),
            "bytes": metrics.get("total_size"),
            "total_requests": metrics.get("total_requests"),
            "unknown_age_ratio": metrics.get("unknown_age_ratio"),
            "unknown_size_ratio": metrics.get("unknown_size_ratio"),
            "parsed_fraction": metrics.get("parsed_fraction"),
            "truncated": bool(payload.get("truncated")),
            "note": _clip(payload.get("note"), 400) if payload.get("note") else None,
        }
    return {"truncated": bool(payload.get("truncated"))} if payload.get("truncated") else None


def _latest_drift_artifact(conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT id, title, summary, payload_json_sanitized, created_at "
        "FROM task_artifacts WHERE task_id = ? AND artifact_type = 'drift_report' "
        "ORDER BY created_at DESC, rowid DESC LIMIT 1",
        (task_id,),
    ).fetchone()
    if row is None:
        return None
    payload = _load(row["payload_json_sanitized"])
    return {
        "artifact_id": row["id"],
        "title": row["title"],
        "summary": row["summary"],
        "created_at": row["created_at"],
        "output": payload,
    }


def _analysis(conn: sqlite3.Connection, task_id: str) -> dict[str, Any]:
    cost_row = _latest_tool(conn, task_id, COST_TOOLS)
    inv_row = _latest_tool(conn, task_id, INVENTORY_TOOLS, kind="inventory")
    log_row = _latest_tool(conn, task_id, ACCESS_LOG_TOOLS, kind="access_log")
    drift_art = _latest_drift_artifact(conn, task_id)
    drift_tool = _latest_tool(conn, task_id, DRIFT_TOOLS)

    def pack(row: dict[str, Any] | None, extra: dict[str, Any] | None = None) -> dict[str, Any] | None:
        if not row:
            return extra
        payload = row["output"]
        return {
            "tool": row.get("tool"),
            "call_id": row.get("call_id"),
            "run_id": row.get("run_id"),
            "created_at": row.get("created_at"),
            "document": payload,
            "coverage": _coverage_from(payload),
            **(extra or {}),
        }

    inventory_doc = None
    if inv_row:
        payload = inv_row["output"]
        inventory_doc = pack(inv_row)
        if inventory_doc and isinstance(payload.get("metrics"), dict):
            inventory_doc["document"] = payload["metrics"]
            inventory_doc["coverage"] = _coverage_from(payload)

    access_doc = None
    if log_row:
        payload = log_row["output"]
        access_doc = pack(log_row)
        if access_doc and isinstance(payload.get("metrics"), dict):
            access_doc["document"] = payload["metrics"]
            access_doc["coverage"] = _coverage_from(payload)

    drift_doc = None
    if drift_art and drift_art.get("output"):
        drift_doc = {
            "tool": "compare_task_drift",
            "artifact_id": drift_art["artifact_id"],
            "call_id": (drift_tool or {}).get("call_id"),
            "run_id": (drift_tool or {}).get("run_id"),
            "created_at": drift_art["created_at"],
            "document": drift_art["output"],
            "coverage": _coverage_from(drift_art["output"]),
        }
    elif drift_tool:
        drift_doc = pack(drift_tool)

    return {
        "cost": pack(cost_row),
        "inventory": inventory_doc,
        "access_log": access_doc,
        "drift": drift_doc,
    }


def _chain_for_finding(
    finding: dict[str, Any],
    analysis: dict[str, Any],
) -> dict[str, Any] | None:
    source_run = finding.get("source_run_id")
    evidence = finding.get("evidence") if isinstance(finding.get("evidence"), dict) else {}
    tool = evidence.get("tool") if isinstance(evidence.get("tool"), str) else None

    for key in ("cost", "inventory", "access_log", "drift"):
        doc = analysis.get(key)
        if not doc:
            continue
        if tool and doc.get("tool") == tool:
            return {
                "kind": "artifact" if doc.get("artifact_id") else "tool",
                "id": doc.get("artifact_id") or doc.get("call_id") or doc.get("run_id"),
                "tool": doc.get("tool"),
                "created_at": doc.get("created_at"),
                "coverage": doc.get("coverage"),
                "review": "report" if key == "drift" else "evidence",
            }
        if source_run and doc.get("run_id") == source_run:
            return {
                "kind": "execution",
                "id": source_run,
                "tool": doc.get("tool"),
                "created_at": doc.get("created_at"),
                "coverage": doc.get("coverage"),
                "review": "execution",
            }

    if source_run:
        return {
            "kind": "execution",
            "id": source_run,
            "tool": tool,
            "created_at": finding.get("created_at"),
            "coverage": None,
            "review": "execution",
        }
    if tool:
        return {
            "kind": "tool",
            "id": None,
            "tool": tool,
            "created_at": finding.get("created_at"),
            "coverage": None,
            "review": "evidence",
        }
    return None


def _findings(conn: sqlite3.Connection, task_id: str, analysis: dict[str, Any]) -> list[dict[str, Any]]:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(session_findings)")}
    has_evidence = "evidence_json" in cols
    sql = (
        "SELECT id, source_run_id, category, severity, confidence, kind, title, "
        "interpretation, created_at"
        + (", evidence_json" if has_evidence else "")
        + " FROM session_findings WHERE session_id = ? ORDER BY rowid DESC LIMIT ?"
    )
    rows = conn.execute(sql, (task_id, _MAX_FINDINGS)).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        evidence = _load(row["evidence_json"]) if has_evidence else None
        finding = {
            "id": row["id"],
            "title": row["title"],
            "severity": row["severity"],
            "category": row["category"],
            "confidence": row["confidence"],
            "kind": row["kind"],
            "interpretation": row["interpretation"],
            "source_run_id": row["source_run_id"],
            "created_at": row["created_at"],
            "evidence": evidence if isinstance(evidence, dict) else None,
        }
        chain = _chain_for_finding(finding, analysis)
        item = {
            "id": finding["id"],
            "title": finding["title"],
            "severity": finding["severity"],
            "category": finding["category"],
            "confidence": finding["confidence"],
            "kind": finding["kind"],
            "interpretation": finding["interpretation"],
            "source_run_id": finding["source_run_id"],
            "created_at": finding["created_at"],
            "source_tool": (finding.get("evidence") or {}).get("tool") if finding.get("evidence") else None,
            "chain": chain,
            "gap": None if chain else "no_direct_evidence",
        }
        out.append(item)
    return out


def project(conn: sqlite3.Connection, task_id: str) -> dict[str, Any]:
    """Latest deterministic analysis documents plus finding evidence chains."""
    analysis = _analysis(conn, task_id)
    findings = _findings(conn, task_id, analysis)
    figures: list[dict[str, Any]] = []
    cost = analysis.get("cost")
    if cost and isinstance(cost.get("document"), dict):
        doc = cost["document"]
        delta = doc.get("monthly_cost_delta")
        figures.append({
            "id": "monthly_cost_delta",
            "label": "monthly_cost_delta",
            "value": (delta or {}).get("usd_per_month_at_365d") if isinstance(delta, dict) else None,
            "estimate": True,
            "present": isinstance(delta, dict) and delta.get("usd_per_month_at_365d") is not None,
            "coverage": cost.get("coverage"),
            "chain": {
                "kind": "tool",
                "id": cost.get("call_id"),
                "tool": cost.get("tool"),
                "created_at": cost.get("created_at"),
                "coverage": cost.get("coverage"),
                "review": "evidence",
            } if cost.get("call_id") else None,
            "gap": None if cost.get("call_id") else "no_direct_evidence",
        })
    drift = analysis.get("drift")
    if drift and isinstance(drift.get("document"), dict):
        trend = drift["document"].get("inventory_trend")
        figures.append({
            "id": "inventory_trend",
            "label": "inventory_trend",
            "value": (trend or {}).get("object_count_delta") if isinstance(trend, dict) else None,
            "estimate": True,
            "present": isinstance(trend, dict),
            "coverage": drift.get("coverage"),
            "chain": {
                "kind": "artifact" if drift.get("artifact_id") else "tool",
                "id": drift.get("artifact_id") or drift.get("call_id"),
                "tool": drift.get("tool"),
                "created_at": drift.get("created_at"),
                "coverage": drift.get("coverage"),
                "review": "report",
            } if (drift.get("artifact_id") or drift.get("call_id")) else None,
            "gap": None if (drift.get("artifact_id") or drift.get("call_id")) else "no_direct_evidence",
        })
    return {
        "task_id": task_id,
        "findings": findings,
        "figures": figures,
        "analysis": analysis,
    }
