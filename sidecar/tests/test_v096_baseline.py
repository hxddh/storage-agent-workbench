"""v0.96 — baselines and Drift three-way finding classification."""

import sqlite3

from app.analysis import baseline as base_mod
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


def test_no_baseline_is_explicit_gap():
    report = base_mod.compare(None, {"snapshot": {"findings": []}})
    assert report["kind"] == "gap"
    assert report["code"] == "no_baseline"
    assert report["inventory_trend"] is None


def test_drift_three_way_and_config_diff(tmp_path):
    conn = _db(tmp_path / "b.db")
    snap1 = base_mod.snapshot(
        inventory={"object_count": 10, "total_size": 100},
        lifecycle={"facts": {"has_abort_mpu": False, "lifecycle_status": "not_configured"}},
        findings=[{"title": "No AbortIncompleteMultipartUpload rule", "severity": "warning"}],
    )
    prev = base_mod.capture(conn, "task", snap1)
    snap2 = base_mod.snapshot(
        inventory={"object_count": 12, "total_size": 150},
        lifecycle={"facts": {"has_abort_mpu": True, "lifecycle_status": "available"}},
        findings=[{"title": "Lifecycle opportunity", "severity": "info"}],
    )
    report = base_mod.compare(prev, {"snapshot": snap2})
    assert report["kind"] == "drift"
    titles_added = {f["title"] for f in report["findings"]["added"]}
    titles_resolved = {f["title"] for f in report["findings"]["resolved"]}
    assert "Lifecycle opportunity" in titles_added
    assert "No AbortIncompleteMultipartUpload rule" in titles_resolved
    assert report["findings"]["still_present"] == []
    assert report["inventory_trend"]["object_count_delta"] == 2
    assert any(d["key"] == "has_abort_mpu" for d in report["config_diff"])
    base_mod.record_drift_artifact(conn, "task", report)
    arts = store.list_artifacts(conn, "task")
    assert any(a["artifact_type"] == "drift_report" for a in arts)
    assert any(a["artifact_type"] == "baseline" for a in arts)
