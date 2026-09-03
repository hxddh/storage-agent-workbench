"""Deterministic cost/plan/baseline/drift/verify tools for the session Agent.

All local, all read-only toward the cloud. Raw inventory rows never enter the
model context; only bounded simulator/plan/drift documents do.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any, Callable

from .. import audit
from ..analysis import baseline as baseline_mod
from ..analysis import cost_sim
from ..analysis import prices
from ..analysis import remediation as plan_mod
from ..security.redaction import redact_text
from ..task_runtime import store

_MAX_JSON = 8000


def _err(msg: str) -> str:
    return json.dumps({"error": redact_text(str(msg))[:300]})


def _out(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, default=str, ensure_ascii=False)
    if len(raw) > _MAX_JSON:
        payload = {**payload, "truncated": True}
        raw = json.dumps(payload, default=str, ensure_ascii=False)[:_MAX_JSON]
    return raw


def _latest_inventory(conn: sqlite3.Connection, session_id: str) -> dict[str, Any] | None:
    from ..analysis.correlation import collect_snapshot, _tool_outputs
    snap = collect_snapshot(_tool_outputs(conn, session_id))
    inv = snap.get("inventory")
    return inv if isinstance(inv, dict) else None


def _latest_lifecycle(conn: sqlite3.Connection, session_id: str) -> dict[str, Any] | None:
    from ..analysis.correlation import collect_snapshot, _tool_outputs
    snap = collect_snapshot(_tool_outputs(conn, session_id))
    life = snap.get("lifecycle") or snap.get("cost")
    return life if isinstance(life, dict) else None


def _findings(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT title, severity, category FROM session_findings "
        "WHERE session_id = ? ORDER BY rowid DESC LIMIT 40",
        (session_id,),
    ).fetchall()
    return [{"title": r["title"], "severity": r["severity"],
             "category": r["category"]} for r in rows]


def build(conn: sqlite3.Connection, function_tool: Callable,
          session_id: str | None, activity: list[dict[str, Any]] | None = None) -> list[Any]:
    if not session_id:
        return []

    def _rec(name: str, summary: str) -> None:
        # v1.13 — full activity shape (id/target/result/ok/status) like every
        # other tool family: these run real deterministic compute, so they
        # render as tool rows and persist as tool.completed events instead of
        # empty shells in the event log.
        if activity is not None:
            activity.append({"id": uuid.uuid4().hex, "tool": name,
                             "target": session_id or "", "result": summary[:80],
                             "ok": True, "status": "completed"})
        audit.record(conn, "session_tool",
                     {"tool": name, "session_id": session_id},
                     run_id=None, session_id=session_id)

    @function_tool
    def simulate_storage_cost(candidates_json: str = "") -> str:
        """Project storage-class mix and monthly cost under candidate lifecycle
        rules using THIS Task's bounded inventory aggregates and the local
        price table. Dollar figures are withheld until the price table is
        confirmed. No inventory → an explicit gap, never invented numbers.
        Optional candidates_json is a JSON list of
        {kind: transition|expiration|abort_mpu, after_days, from_class, to_class}."""
        _rec("simulate_storage_cost", "simulate")
        candidates = []
        if candidates_json.strip():
            try:
                candidates = json.loads(candidates_json)
            except (TypeError, ValueError):
                return _err("candidates_json is not valid JSON")
        result = cost_sim.simulate(
            inventory=_latest_inventory(conn, session_id),
            lifecycle=_latest_lifecycle(conn, session_id),
            candidates=candidates,
            price_table=prices.simulator_input(conn),
        )
        return _out(result)

    @function_tool
    def draft_remediation_plan() -> str:
        """Draft a versioned, typed remediation plan Artifact from current
        findings + a cost simulation. The plan is local and read-only: the user
        applies JSON in their own console. Does not mutate storage."""
        _rec("draft_remediation_plan", "draft plan")
        inv = _latest_inventory(conn, session_id)
        life = _latest_lifecycle(conn, session_id)
        findings = _findings(conn, session_id)
        candidates = plan_mod.default_actions(inv, life, findings)
        sim = cost_sim.simulate(
            inventory=inv, lifecycle=life, candidates=candidates,
            price_table=prices.simulator_input(conn),
        )
        plan = plan_mod.draft(
            conn, session_id, inventory=inv, lifecycle=life,
            findings=findings, simulation=sim,
        )
        return _out({"plan_id": plan["id"], "version": plan["version"],
                     "status": plan["status"], "actions": plan["plan"].get("actions"),
                     "simulation": {
                         "kind": sim.get("kind"),
                         "gaps": sim.get("gaps"),
                         "coverage": sim.get("coverage"),
                         "monthly_cost_delta": sim.get("monthly_cost_delta"),
                     }})

    @function_tool
    def verify_remediation_plan() -> str:
        """Diff the latest remediation plan against the latest read-only
        lifecycle review already on this Task. Does not call mutating APIs.
        Status becomes verified / partially_verified / proposed (cannot_verify
        stays proposed)."""
        _rec("verify_remediation_plan", "verify plan")
        plan = plan_mod.latest(conn, session_id)
        if plan is None:
            return _err("No remediation plan on this Task.")
        live = _latest_lifecycle(conn, session_id)
        updated = plan_mod.apply_verification(conn, plan["id"], live)
        return _out({"plan_id": plan["id"], "status": (updated or {}).get("status"),
                     "verification": ((updated or {}).get("plan") or {}).get("verification")})

    @function_tool
    def capture_task_baseline() -> str:
        """Persist a versioned baseline: bounded inventory overview, lifecycle
        facts, and findings. Not raw rows."""
        _rec("capture_task_baseline", "capture baseline")
        ctx = store.latest_context(conn, session_id)
        snap = baseline_mod.snapshot(
            inventory=_latest_inventory(conn, session_id),
            lifecycle=_latest_lifecycle(conn, session_id),
            findings=_findings(conn, session_id),
            context_version=(ctx or {}).get("version"),
        )
        row = baseline_mod.capture(conn, session_id, snap)
        return _out({"baseline_id": row["id"], "version": row["version"],
                     "created_at": row["created_at"]})

    @function_tool
    def compare_task_drift() -> str:
        """Compare the current bounded snapshot to the latest baseline. Missing
        baseline is an explicit gap, never a fabricated trend. Findings are
        classified added / resolved / still_present."""
        _rec("compare_task_drift", "drift")
        prev = baseline_mod.latest(conn, session_id)
        ctx = store.latest_context(conn, session_id)
        current_snap = baseline_mod.snapshot(
            inventory=_latest_inventory(conn, session_id),
            lifecycle=_latest_lifecycle(conn, session_id),
            findings=_findings(conn, session_id),
            context_version=(ctx or {}).get("version"),
        )
        report = baseline_mod.compare(prev, {"snapshot": current_snap})
        baseline_mod.record_drift_artifact(conn, session_id, report)
        return _out(report)

    @function_tool
    def get_price_table_status() -> str:
        """Show whether the local storage price table is still the example
        schedule or has been confirmed. Never contains credentials."""
        _rec("get_price_table_status", "price table")
        doc = prices.load(conn)
        return _out({"confirmed": doc["confirmed"], "example": doc["example"],
                     "note": doc["note"], "updated_at": doc["updated_at"],
                     "classes": sorted((doc.get("rates") or {}).get("storage_gb_month", {}))})

    @function_tool
    def set_task_revisit_days(interval_days: int, enabled: bool = True) -> str:
        """Set this Task's optional revisit interval (1–365 days). Revisits are
        read-only Executions submitted through the normal runtime when the
        Sidecar is running. Closing the app skips them until catch-up."""
        _rec("set_task_revisit_days", "revisit")
        from ..task_runtime import revisit as revisit_mod
        row = revisit_mod.set_schedule(
            conn, session_id, interval_days=int(interval_days), enabled=bool(enabled),
        )
        return _out(row)

    tools = [
        simulate_storage_cost, draft_remediation_plan, verify_remediation_plan,
        capture_task_baseline, compare_task_drift, get_price_table_status,
        set_task_revisit_days,
    ]
    simulate_storage_cost.name = "simulate_storage_cost"
    draft_remediation_plan.name = "draft_remediation_plan"
    verify_remediation_plan.name = "verify_remediation_plan"
    capture_task_baseline.name = "capture_task_baseline"
    compare_task_drift.name = "compare_task_drift"
    get_price_table_status.name = "get_price_table_status"
    set_task_revisit_days.name = "set_task_revisit_days"
    return tools
