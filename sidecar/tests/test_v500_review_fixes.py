"""Regressions from the v5 review: what the model re-reads, what an import may
read, what the importer tolerates, what an out-of-task call may overwrite."""

from __future__ import annotations

import json
import time

from app import config
from app.core import store
from tests.fake_model import FakeModel, text_turn, tool_turn


def _settle(client, tid, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/tasks/{tid}").json()
        if snap["state"] not in ("working", "queued"):
            return snap
        time.sleep(0.05)
    raise AssertionError("never settled")


def test_a_later_turn_replays_tool_output_inside_the_envelope(client):
    with FakeModel([tool_turn("query_estate", {}), text_turn("None."), text_turn("Still none.")]) as fake:
        client.post("/providers/models", json={"name": "f", "kind": "openai-compatible", "base_url": fake.base_url,
                                               "model": "fake-model"})
        tid = client.post("/tasks", json={"direction": "Files?"}).json()["task"]["id"]
        _settle(client, tid)
        client.post(f"/tasks/{tid}/turns", json={"direction": "And now?"})
        _settle(client, tid)
    replayed = [m for m in fake.requests[-1]["messages"] if m.get("role") == "tool"]
    assert replayed and replayed[0]["content"].startswith("<<external_untrusted_data>>")


def _survey_with_source(conn, pid, *, source_bucket):
    store.add_artifact(conn, kind="survey", title="s", provider_id=pid, payload={"buckets": [{
        "bucket_name": "app", "evidence_sources": [{"source_type": "server_access_logging", "status": "available",
                                                    "detail": {"target_bucket": source_bucket, "target_prefix": "logs/"}}]}]})


def test_an_import_never_reads_a_source_outside_the_accounts_scope(client, conn):
    from app.engines import evidence
    pid = client.post("/providers/clouds", json={
        "name": "scoped", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "access_key": "AKIAIOSFODNN7EXAMPLE", "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "allowed_buckets": ["app"]}).json()["id"]
    _survey_with_source(conn, pid, source_bucket="central-logs")
    try:
        evidence.import_source(conn, task_id="t", provider_id=pid, bucket="app", source_type="access_log",
                               time_range_start="2026-09-01T00:00:00Z", time_range_end="2026-09-02T00:00:00Z")
    except evidence.ImportRefused as exc:
        assert "outside this account's scope" in str(exc)
    else:
        raise AssertionError("an out-of-scope source must be refused before any listing")


def test_the_importer_skips_orphan_v4_rows_instead_of_losing_everything(conn):
    import sqlite3

    from app import importer
    from tests.test_v500_importer_files import _legacy
    _legacy()
    old = sqlite3.connect(str(config.legacy_db_path()))
    old.execute("INSERT INTO issues (id, provider_id, bucket, code, fingerprint, severity, status, first_seen_at, "
                "last_seen_at, updated_at) VALUES ('orphan','gone','b','public_exposure','fp-o','high','open','x','x','x')")
    old.execute("INSERT INTO estate_buckets VALUES ('gone','b',NULL,'{}','x',NULL,NULL)")
    old.commit()
    old.close()
    counts = importer.run_once(conn)
    assert counts is not None and counts["issues"] == 1 and counts["buckets"] == 1 and counts["tasks"] == 1


def test_a_call_outside_a_task_never_unlinks_the_task_that_found_an_issue(conn):
    from app.estate import store as estate
    conn.execute("INSERT INTO cloud_providers (id, name, provider_type, created_at, updated_at) "
                 "VALUES ('p1','prod','s3','x','x')")
    task = store.create_task(conn, "found it")
    iid = estate.observe(conn, "p1", "b1", {"no_default_encryption": True}, source="review",
                         task_id=task["id"])[0]["issue_id"]
    estate.upsert_bucket(conn, "p1", "b1", task_id=task["id"])
    estate.observe(conn, "p1", "b1", {"no_default_encryption": True}, source="review", task_id="")
    estate.upsert_bucket(conn, "p1", "b1", task_id="")
    conn.commit()
    assert conn.execute("SELECT source_task_id FROM issues WHERE id = ?", (iid,)).fetchone()[0] == task["id"]
    assert conn.execute("SELECT source_task_id FROM estate_buckets").fetchone()[0] == task["id"]


def test_withdrawing_a_queued_first_direction_moves_the_head_off_it(client, conn):
    from app.agent.runtime import RUNTIME
    task = store.create_task(conn, "t")
    first = store.create_turn(conn, task["id"], "one", status="completed")
    queued = store.create_turn(conn, task["id"], "rewrite", parent_turn_id="")
    assert store.get_task(conn, task["id"])["head_turn_id"] == queued["id"]
    assert RUNTIME.cancel_queued(conn, task["id"], queued["id"])
    assert store.get_task(conn, task["id"])["head_turn_id"] == first["id"]


def test_mcp_results_are_bounded(client):
    from app.agent.tools import registry
    td = registry.REGISTRY["triage_error"]
    big = "AccessDenied " * 20_000
    out = registry.call_direct("triage_error", {"text": big}, actor="mcp", allowed=frozenset({"triage_error"}))
    assert len(json.dumps(out)) <= td.max_model_chars + 2_000
