"""Versioned remediation-plan documents and read-only Verify diffs.

Plans are local artifacts. Applying a lifecycle JSON is the user's job in their
own console/CLI. Verify re-reads configuration with existing read-only tools
and classifies each action as applied / not_applied / partial / cannot_verify.
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

STATUS_PROPOSED = "proposed"
STATUS_VERIFIED = "verified"
STATUS_PARTIAL = "partially_verified"
STATUS_STALE = "stale"
_STATUSES = (STATUS_PROPOSED, STATUS_VERIFIED, STATUS_PARTIAL, STATUS_STALE)


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


def _doc(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "execution_id": row["execution_id"],
        "version": row["version"],
        "status": row["status"],
        "title": row["title"],
        "plan": _loads(row["plan_json_sanitized"], {}),
        "simulation": _loads(row["simulation_json_sanitized"], None),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def latest(conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM remediation_plans WHERE task_id = ? "
        "ORDER BY version DESC LIMIT 1", (task_id,),
    ).fetchone()
    return _doc(row) if row else None


def get(conn: sqlite3.Connection, plan_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM remediation_plans WHERE id = ?", (plan_id,),
    ).fetchone()
    return _doc(row) if row else None


def list_plans(conn: sqlite3.Connection, task_id: str,
               limit: int = 20) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM remediation_plans WHERE task_id = ? "
        "ORDER BY version DESC LIMIT ?",
        (task_id, max(1, int(limit))),
    ).fetchall()
    return [_doc(r) for r in rows]


def _next_version(conn: sqlite3.Connection, task_id: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(MAX(version), 0) FROM remediation_plans WHERE task_id = ?",
        (task_id,),
    ).fetchone()
    return int(row[0]) + 1


def _lifecycle_json(actions: list[dict[str, Any]]) -> dict[str, Any]:
    rules = []
    for action in actions:
        kind = action.get("kind")
        after = int(action.get("after_days") or 0)
        if kind == "transition":
            rules.append({
                "ID": action.get("id") or "transition",
                "Status": "Enabled",
                "Filter": {"Prefix": action.get("prefix") or ""},
                "Transitions": [{
                    "Days": after,
                    "StorageClass": action.get("to_class") or "STANDARD_IA",
                }],
            })
        elif kind == "expiration":
            rules.append({
                "ID": action.get("id") or "expiration",
                "Status": "Enabled",
                "Filter": {"Prefix": action.get("prefix") or ""},
                "Expiration": {"Days": after},
            })
        elif kind == "abort_mpu":
            rules.append({
                "ID": action.get("id") or "abort-mpu",
                "Status": "Enabled",
                "AbortIncompleteMultipartUpload": {
                    "DaysAfterInitiation": max(1, after or 7),
                },
            })
    return {"Rules": rules}


def default_actions(inventory: dict[str, Any] | None,
                    lifecycle: dict[str, Any] | None,
                    findings: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Deterministic suggestions from bounded facts — not a model plan."""
    actions: list[dict[str, Any]] = []
    facts = (lifecycle or {}).get("facts") if isinstance(lifecycle, dict) else {}
    facts = facts or {}
    finding_titles = " ".join(
        str(f.get("title") or "") for f in (findings or []) if isinstance(f, dict)
    ).lower()
    inv = inventory or {}
    age = {a.get("bucket"): int(a.get("count") or 0)
           for a in (inv.get("object_age_distribution") or []) if isinstance(a, dict)}
    old = age.get("365d+", 0)
    count = int(inv.get("object_count") or 0)

    if not facts.get("has_abort_mpu"):
        actions.append({
            "id": "abort-mpu-7d",
            "kind": "abort_mpu",
            "after_days": 7,
            "title": "Abort incomplete multipart uploads after 7 days",
            "finding_refs": ["No AbortIncompleteMultipartUpload rule"] if "multipart" in finding_titles or not facts.get("has_abort_mpu") else [],
            "apply_where": "console_or_cli",
            "read_only": True,
        })
    if not facts.get("has_transition") and count and old / max(count, 1) >= 0.2:
        actions.append({
            "id": "transition-ia-90",
            "kind": "transition",
            "from_class": "STANDARD",
            "to_class": "STANDARD_IA",
            "after_days": 90,
            "title": "Transition STANDARD objects to STANDARD_IA after 90 days",
            "finding_refs": ["Lifecycle opportunity", "No transition rules"],
            "apply_where": "console_or_cli",
            "read_only": True,
        })
    if not facts.get("has_expiration") and count and old / max(count, 1) >= 0.3:
        actions.append({
            "id": "expire-365",
            "kind": "expiration",
            "from_class": "STANDARD",
            "after_days": 365,
            "title": "Expire objects after 365 days (review before applying)",
            "finding_refs": ["No expiration rules", "Lifecycle opportunity"],
            "apply_where": "console_or_cli",
            "read_only": True,
        })
    return actions[:8]


def draft(conn: sqlite3.Connection, task_id: str, *,
          inventory: dict[str, Any] | None,
          lifecycle: dict[str, Any] | None,
          findings: list[dict[str, Any]] | None,
          simulation: dict[str, Any] | None,
          execution_id: str | None = None,
          title: str | None = None) -> dict[str, Any]:
    actions = default_actions(inventory, lifecycle, findings)
    for action in actions:
        action["lifecycle_fragment"] = _lifecycle_json([action])
    checklist = [
        "Apply only in your own console or CLI — Storage Agent stays read-only.",
        "Re-run Verify on this Task after applying.",
        "Confirm the local price table before treating dollar deltas as estimates.",
        "Abort-MPU and expiration have no object-row proof in this plan.",
    ]
    body = {
        "actions": actions,
        "finding_refs": [redact_text(str(f.get("title") or ""))[:200]
                         for f in (findings or []) if isinstance(f, dict)][:20],
        "checklist": checklist,
        "apply_in": "operator_console_or_cli",
        "mutation": False,
    }
    now = utcnow()
    version = _next_version(conn, task_id)
    plan_id = _new_id()
    conn.execute(
        "INSERT INTO remediation_plans (id, task_id, execution_id, version, status, "
        "title, plan_json_sanitized, simulation_json_sanitized, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (plan_id, task_id, execution_id, version, STATUS_PROPOSED,
         redact_text(title or "Remediation plan")[:200],
         _dumps(body), _dumps(simulation) if simulation else None, now, now),
    )
    # Prior proposed plans on this task are stale once a newer version exists.
    conn.execute(
        "UPDATE remediation_plans SET status = ?, updated_at = ? "
        "WHERE task_id = ? AND id != ? AND status = ?",
        (STATUS_STALE, now, task_id, plan_id, STATUS_PROPOSED),
    )
    store.ensure_task(conn, task_id)
    task_artifacts.record_remediation_plan(
        conn, task_id, plan_id,
        title=title or f"Remediation plan v{version}",
        execution_id=execution_id,
        summary=f"{len(actions)} recommended action(s); status {STATUS_PROPOSED}",
    )
    conn.commit()
    return get(conn, plan_id)  # type: ignore[return-value]


def set_status(conn: sqlite3.Connection, plan_id: str, status: str,
               verification: dict[str, Any] | None = None) -> dict[str, Any] | None:
    if status not in _STATUSES:
        raise ValueError(f"invalid plan status: {status!r}")
    row = conn.execute(
        "SELECT plan_json_sanitized FROM remediation_plans WHERE id = ?", (plan_id,),
    ).fetchone()
    if row is None:
        return None
    plan = _loads(row["plan_json_sanitized"], {})
    if verification is not None:
        plan["verification"] = redact(verification)
    now = utcnow()
    conn.execute(
        "UPDATE remediation_plans SET status = ?, plan_json_sanitized = ?, updated_at = ? "
        "WHERE id = ?",
        (status, _dumps(plan), now, plan_id),
    )
    conn.commit()
    return get(conn, plan_id)


def classify_verify(actions: list[dict[str, Any]],
                    live_lifecycle: dict[str, Any] | None) -> dict[str, Any]:
    """Diff plan actions against a read-only lifecycle review payload."""
    facts = (live_lifecycle or {}).get("facts") if isinstance(live_lifecycle, dict) else {}
    facts = facts or {}
    live_rules = (live_lifecycle or {}).get("rules") if isinstance(live_lifecycle, dict) else None
    results: list[dict[str, Any]] = []
    if live_lifecycle is None or (
            facts.get("lifecycle_status") in (None, "error", "access_denied")
            and not live_rules and not facts):
        for action in actions:
            results.append({
                "id": action.get("id"),
                "kind": action.get("kind"),
                "status": "cannot_verify",
                "detail": "No live lifecycle read is available to diff against.",
            })
        return {"overall": "cannot_verify", "actions": results}

    status_name = str(facts.get("lifecycle_status") or "")
    if status_name in ("access_denied", "provider_unsupported", "error"):
        for action in actions:
            results.append({
                "id": action.get("id"),
                "kind": action.get("kind"),
                "status": "cannot_verify",
                "detail": f"lifecycle_status={status_name}",
            })
        return {"overall": "cannot_verify", "actions": results}

    for action in actions:
        kind = action.get("kind")
        applied = False
        partial = False
        detail = ""
        if kind == "abort_mpu":
            applied = bool(facts.get("has_abort_mpu"))
            detail = "AbortIncompleteMultipartUpload present" if applied else "not present"
        elif kind == "transition":
            applied = bool(facts.get("has_transition"))
            if live_rules:
                want = str(action.get("to_class") or "")
                days = int(action.get("after_days") or 0)
                applied = _rule_matches(live_rules, kind="transition", to_class=want, days=days)
                partial = bool(facts.get("has_transition")) and not applied
            detail = "transition rule matched" if applied else (
                "some transition exists but days/class differ" if partial else "no matching transition"
            )
        elif kind == "expiration":
            applied = bool(facts.get("has_expiration"))
            if live_rules:
                days = int(action.get("after_days") or 0)
                applied = _rule_matches(live_rules, kind="expiration", days=days)
                partial = bool(facts.get("has_expiration")) and not applied
            detail = "expiration rule matched" if applied else (
                "expiration exists but days differ" if partial else "no matching expiration"
            )
        else:
            results.append({
                "id": action.get("id"), "kind": kind,
                "status": "cannot_verify", "detail": "unknown action kind",
            })
            continue
        status = "applied" if applied else ("partial" if partial else "not_applied")
        results.append({"id": action.get("id"), "kind": kind, "status": status, "detail": detail})

    statuses = {r["status"] for r in results}
    if statuses == {"applied"}:
        overall = STATUS_VERIFIED
    elif statuses == {"cannot_verify"} or "cannot_verify" in statuses and len(statuses) == 1:
        overall = "cannot_verify"
    elif "applied" in statuses and statuses - {"applied"}:
        overall = STATUS_PARTIAL
    elif statuses <= {"not_applied", "partial"}:
        overall = STATUS_PROPOSED if "partial" not in statuses else STATUS_PARTIAL
    else:
        overall = STATUS_PARTIAL
    # Map cannot_verify-only to partially_verified only when mixed; keep plan
    # status in the product enum.
    plan_status = {
        STATUS_VERIFIED: STATUS_VERIFIED,
        STATUS_PARTIAL: STATUS_PARTIAL,
        STATUS_PROPOSED: STATUS_PROPOSED,
        "cannot_verify": STATUS_PROPOSED,
    }.get(overall, STATUS_PARTIAL)
    return {"overall": overall, "plan_status": plan_status, "actions": results}


def _rule_matches(rules: Any, *, kind: str, days: int,
                  to_class: str | None = None) -> bool:
    if not isinstance(rules, list):
        if isinstance(rules, dict):
            rules = rules.get("Rules") or rules.get("rules") or []
        else:
            return False
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        if kind == "transition":
            trans = rule.get("Transitions") or rule.get("transitions") or []
            for tr in trans:
                if not isinstance(tr, dict):
                    continue
                got_days = int(tr.get("Days") or tr.get("days") or -1)
                got_class = str(tr.get("StorageClass") or tr.get("storage_class") or "")
                if got_days == days and (not to_class or got_class.upper() == to_class.upper()):
                    return True
        if kind == "expiration":
            exp = rule.get("Expiration") or rule.get("expiration") or {}
            if isinstance(exp, dict) and int(exp.get("Days") or exp.get("days") or -1) == days:
                return True
        if kind == "abort_mpu":
            abort = (rule.get("AbortIncompleteMultipartUpload")
                     or rule.get("abort_incomplete_multipart_upload"))
            if abort:
                return True
    return False


def apply_verification(conn: sqlite3.Connection, plan_id: str,
                       live_lifecycle: dict[str, Any] | None) -> dict[str, Any] | None:
    plan = get(conn, plan_id)
    if plan is None:
        return None
    actions = (plan.get("plan") or {}).get("actions") or []
    verification = classify_verify(actions, live_lifecycle)
    verification["simulated"] = False
    verification["compared_at"] = utcnow()
    # Attach coverage from the stored simulation if present.
    sim = plan.get("simulation") if isinstance(plan.get("simulation"), dict) else {}
    if sim:
        verification["simulation_coverage"] = sim.get("coverage")
    status = verification.get("plan_status") or STATUS_PROPOSED
    updated = set_status(conn, plan_id, status, verification)
    return updated
