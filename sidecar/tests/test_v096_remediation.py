"""v0.96 — remediation plan draft + verify diff."""

import sqlite3

from app.analysis import remediation as plan_mod
from app.migrations import apply_migrations
from app.task_runtime import store


def _db(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)",
        ("task", "t", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"),
    )
    store.ensure_task(conn, "task", "t", "g")
    conn.commit()
    return conn


def test_draft_and_verify_statuses(tmp_path):
    conn = _db(tmp_path / "p.db")
    inventory = {
        "object_count": 100,
        "total_size": 10**12,
        "object_age_distribution": [{"bucket": "365d+", "count": 80},
                                    {"bucket": "0-7d", "count": 20}],
    }
    lifecycle = {"facts": {"has_abort_mpu": False, "has_transition": False,
                           "has_expiration": False, "lifecycle_status": "not_configured"}}
    plan = plan_mod.draft(conn, "task", inventory=inventory, lifecycle=lifecycle,
                          findings=[{"title": "No AbortIncompleteMultipartUpload rule"}],
                          simulation={"kind": "simulation", "coverage": {"object_count": 100}})
    assert plan["status"] == "proposed"
    assert plan["plan"]["actions"]
    assert any(a["kind"] == "abort_mpu" for a in plan["plan"]["actions"])
    arts = store.list_artifacts(conn, "task")
    assert any(a["artifact_type"] == "remediation_plan" for a in arts)

    live = {"facts": {"has_abort_mpu": True, "has_transition": True,
                      "has_expiration": False, "lifecycle_status": "available"}}
    updated = plan_mod.apply_verification(conn, plan["id"], live)
    assert updated["status"] in ("partially_verified", "proposed", "verified")
    ver = updated["plan"]["verification"]
    abort = next(r for r in ver["actions"] if r["kind"] == "abort_mpu")
    assert abort["status"] == "applied"


def test_cannot_verify_without_live_read(tmp_path):
    actions = [{"id": "a", "kind": "transition", "after_days": 90, "to_class": "STANDARD_IA"}]
    out = plan_mod.classify_verify(actions, None)
    assert out["overall"] == "cannot_verify"
    assert out["actions"][0]["status"] == "cannot_verify"
