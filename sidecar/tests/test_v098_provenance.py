"""v0.98 — read-only provenance projection (no migration)."""

import json
import sqlite3

from app import config
from app.task_runtime import store as task_store


def _db():
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def _task(client, title: str = "Cost and drift"):
    return client.post("/sessions", json={"title": title, "goal": "review cost"}).json()


def test_missing_finding_chain_is_explicit_gap(client):
    task = _task(client)
    with _db() as conn:
        conn.execute(
            "INSERT INTO session_findings (id, session_id, category, severity, confidence, kind, title, interpretation, status, created_at)"
            " VALUES (?, ?, 'info', 'info', 'medium', 'fact', 'Something happened', 'No tool cited.', 'active', datetime('now'))",
            ("f1", task["id"]),
        )
        conn.commit()
    body = client.get(f"/agent-tasks/{task['id']}/provenance").json()
    assert body["task_id"] == task["id"]
    assert body["findings"][0]["gap"] == "no_direct_evidence"
    assert body["findings"][0]["chain"] is None
    assert body["analysis"]["cost"] is None


def test_projects_cost_inventory_and_finding_tool_chain(client):
    task = _task(client)
    sim = {
        "kind": "simulation",
        "estimate": True,
        "gaps": [],
        "coverage": {
            "object_count": 100,
            "bytes": 100000000000,
            "inventory_as_of": "2026-08-01T00:00:00Z",
            "unknown_age_ratio": 0.0,
            "note": "This is an estimate, not a bill.",
        },
        "timeline": [
            {"day": 0, "candidate_class_bytes": {"STANDARD": 100}, "baseline_class_bytes": {"STANDARD": 100},
             "baseline_monthly_cost": {"usd_per_month": 2.3, "estimate": True},
             "candidate_monthly_cost": {"usd_per_month": 2.3, "estimate": True}},
            {"day": 365, "candidate_class_bytes": {"STANDARD_IA": 80, "STANDARD": 20},
             "baseline_class_bytes": {"STANDARD": 100},
             "baseline_monthly_cost": {"usd_per_month": 2.3, "estimate": True},
             "candidate_monthly_cost": {"usd_per_month": 1.2, "estimate": True}},
        ],
        "monthly_cost_delta": {"usd_per_month_at_365d": -1.1, "estimate": True, "horizon_days": 365},
    }
    inv = {
        "type": "inventory",
        "metrics": {
            "object_count": 100,
            "total_size": 100000000000,
            "storage_class_distribution": [{"value": "STANDARD", "count": 100, "size": 100}],
            "object_age_distribution": [{"bucket": "0-7d", "count": 20}, {"bucket": "365d+", "count": 80}],
            "unknown_age_ratio": 0.0,
        },
    }
    with _db() as conn:
        task_store.ensure_task(conn, task["id"], "t", "g")
        conn.execute(
            "INSERT INTO tool_calls (id, run_id, session_id, tool_name, input_json_sanitized, output_json_sanitized, status, duration_ms, created_at)"
            " VALUES (?, NULL, ?, 'simulate_storage_cost', '{}', ?, 'success', 9, datetime('now'))",
            ("call-sim", task["id"], json.dumps(sim)),
        )
        conn.execute(
            "INSERT INTO tool_calls (id, run_id, session_id, tool_name, input_json_sanitized, output_json_sanitized, status, duration_ms, created_at)"
            " VALUES (?, NULL, ?, 'analyze_uploaded_file', '{}', ?, 'success', 9, datetime('now'))",
            ("call-inv", task["id"], json.dumps(inv)),
        )
        conn.execute(
            "INSERT INTO session_findings (id, session_id, source_run_id, category, severity, confidence, kind, title, interpretation, evidence_json, status, created_at)"
            " VALUES (?, ?, NULL, 'cost', 'info', 'high', 'fact', 'Standard-IA saves money', 'Estimate.', ?, 'active', datetime('now'))",
            ("f-cost", task["id"], json.dumps({"tool": "simulate_storage_cost"})),
        )
        conn.commit()
    body = client.get(f"/agent-tasks/{task['id']}/provenance").json()
    assert body["analysis"]["cost"]["document"]["kind"] == "simulation"
    assert body["analysis"]["cost"]["coverage"]["object_count"] == 100
    assert body["analysis"]["inventory"]["document"]["object_count"] == 100
    finding = next(f for f in body["findings"] if f["id"] == "f-cost")
    assert finding["gap"] is None
    assert finding["chain"]["tool"] == "simulate_storage_cost"
    delta = next(f for f in body["figures"] if f["id"] == "monthly_cost_delta")
    assert delta["present"] is True
    assert delta["estimate"] is True
    assert delta["value"] == -1.1


def test_unconfirmed_prices_do_not_invent_a_cost_figure(client):
    task = _task(client, "Unconfirmed prices")
    sim = {
        "kind": "simulation",
        "estimate": True,
        "gaps": [{"kind": "gap", "code": "price_unconfirmed", "message": "Confirm the price table."}],
        "coverage": {"object_count": 10, "bytes": 1},
        "timeline": [{"day": 0, "candidate_class_bytes": {"STANDARD": 1},
                      "baseline_monthly_cost": None, "candidate_monthly_cost": None}],
        "monthly_cost": None,
        "monthly_cost_delta": None,
    }
    with _db() as conn:
        conn.execute(
            "INSERT INTO tool_calls (id, run_id, session_id, tool_name, input_json_sanitized, output_json_sanitized, status, duration_ms, created_at)"
            " VALUES (?, NULL, ?, 'simulate_storage_cost', '{}', ?, 'success', 4, datetime('now'))",
            ("call-gap", task["id"], json.dumps(sim)),
        )
        conn.commit()
    body = client.get(f"/agent-tasks/{task['id']}/provenance").json()
    delta = next(f for f in body["figures"] if f["id"] == "monthly_cost_delta")
    assert delta["present"] is False
    assert delta["value"] is None
    assert body["analysis"]["cost"]["document"]["monthly_cost_delta"] is None


def test_unknown_task_is_404(client):
    assert client.get("/agent-tasks/missing/provenance").status_code == 404
