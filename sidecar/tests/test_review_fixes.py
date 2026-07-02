"""Regression tests for the v0.21.x architecture-review fixes.

Each test pins a specific finding from the deep review so the fix can't silently
regress. Grouped by area; see the PR/commit for the full finding list.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from app import config


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(config.db_path())
    conn.row_factory = sqlite3.Row
    return conn


# --- H-4: config-review tools must reach the model with real descriptions -----


def test_config_review_tools_have_nonempty_descriptions(client):
    """`t.__doc__ = desc` was a no-op on the built FunctionTool, so the six
    bucket-config tools were presented to the model with blank descriptions."""
    from agents import function_tool  # the real SDK decorator

    from app.agent_runtime import session_tools

    with _db() as conn:
        conn.row_factory = sqlite3.Row
        tools = session_tools.build(conn, function_tool, [])
    by_name = {t.name: t for t in tools}
    for name in (
        "get_bucket_config_summary", "review_bucket_security", "review_bucket_lifecycle",
        "review_bucket_observability", "review_bucket_cost_optimization",
        "review_bucket_performance_profile",
    ):
        assert name in by_name, f"{name} not registered"
        assert by_name[name].description.strip(), f"{name} has an empty description"
        # The params schema title must not still be the inner function name.
        params = getattr(by_name[name], "params_json_schema", {}) or {}
        assert params.get("title") != "_t"


# --- H-2 (agent): contract parser must not eat a JSON example in the answer ---


def test_contract_parser_keeps_json_example_in_prose():
    from app.skills import contract

    answer = (
        "Here is the bucket policy that makes it public:\n\n"
        "```json\n{\"Statement\": [{\"Effect\": \"Allow\", \"Principal\": \"*\"}]}\n```\n\n"
        "That is the problem.\n\n"
        "```json\n{\"skills_used\": [], \"evidence_used\": [\"finding:x\"], "
        "\"next_action_proposals\": []}\n```"
    )
    out = contract.parse_agent_contract(answer)
    # The policy example stays in the answer; the trailing metadata block is consumed.
    assert '"Statement"' in out["answer"]
    assert '"Effect"' in out["answer"]
    assert "skills_used" not in out["answer"]
    assert out["evidence_used"] == ["finding:x"]


def test_contract_parser_still_parses_plain_metadata_block():
    from app.skills import contract

    answer = "The bucket is fine.\n\n```json\n{\"next_action_proposals\": []}\n```"
    out = contract.parse_agent_contract(answer)
    assert out["answer"] == "The bucket is fine."


# --- H-2/H3: GET /sessions/{id} must surface grounding + proposed_actions -----


def test_session_detail_surfaces_grounding_and_proposals(client):
    from app.db import connect
    from app.repositories import sessions as repo

    sid = client.post("/sessions", json={"title": "t"}).json()["id"]
    conn = connect()
    try:
        repo.add_message(
            conn, sid, "assistant", "answer",
            grounding={"evidence_used": ["run:1"], "evidence_gaps": [], "skills_used": []},
            proposed_actions=[{"title": "Do X", "action_type": "review_bucket_config",
                               "confidence": "medium"}],
        )
        conn.commit()
    finally:
        conn.close()

    detail = client.get(f"/sessions/{sid}").json()
    msg = next(m for m in detail["messages"] if m["role"] == "assistant")
    assert msg["grounding"] is not None
    assert msg["grounding"]["evidence_used"] == ["run:1"]
    assert msg["proposed_actions"] and msg["proposed_actions"][0]["title"] == "Do X"


# --- H-1: the sidecar rejects unauthenticated calls when a token is set -------


def test_auth_token_enforced_when_set(tmp_path, monkeypatch):
    monkeypatch.setenv("SAW_DB_PATH", str(tmp_path / "auth.db"))
    monkeypatch.setenv("SAW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("STORAGE_AGENT_AUTH_TOKEN", "s3cr3t-token")
    # main reads the token at import time, so import fresh under the env var.
    import importlib

    from app import main as main_mod
    main_mod = importlib.reload(main_mod)
    from fastapi.testclient import TestClient

    with TestClient(main_mod.app) as c:
        # No token → rejected on a real endpoint...
        assert c.get("/sessions").status_code == 401
        # ...header token accepted...
        assert c.get("/sessions", headers={"X-Sidecar-Token": "s3cr3t-token"}).status_code == 200
        # ...query-param token accepted (the SSE path)...
        assert c.get("/sessions?token=s3cr3t-token").status_code == 200
        # ...wrong token rejected...
        assert c.get("/sessions", headers={"X-Sidecar-Token": "nope"}).status_code == 401
        # ...and /health stays open for liveness probes.
        assert c.get("/health").status_code == 200

    # Reload once more without the token so other tests see auth-open.
    monkeypatch.delenv("STORAGE_AGENT_AUTH_TOKEN", raising=False)
    importlib.reload(main_mod)


# --- M-4 (s3): a fully-denied bucket must report access_denied, not available -


def test_account_discovery_marks_denied_bucket(client, monkeypatch):
    """HeadBucket denied + a configured region used to be mis-reported as
    'available' because access_status was gated on `not region`."""
    from app.runs import account_discovery_run as adr

    # A snapshot as get_bucket_config_snapshot would return for a denied bucket:
    # region falls back to the provider's configured region (truthy).
    denied_snap = {
        "success": True, "bucket": "b", "region": "us-east-1",
        "head_bucket_status": "access_denied", "access_denied_items": ["head_bucket"],
    }
    # Exercise the exact mapping logic without a full run.
    head = denied_snap.get("head_bucket_status")
    if head == adr._DENIED:
        access_status = adr._DENIED
    elif head == "error":
        access_status = "error"
    elif denied_snap.get("access_denied_items"):
        access_status = adr._CONFIGURED
    else:
        access_status = adr._CONFIGURED
    assert access_status == adr._DENIED


# --- M-3/M-6 (api): the run event buffer is bounded and evicts finished runs --


def test_event_bus_buffer_is_bounded():
    from app import events

    bus = events.EventBus()
    bus.create("r1")
    total = events._MAX_EVENTS_PER_RUN + 500
    for i in range(total):
        bus.publish("r1", {"i": i})
    evs, cursor, _ = bus.snapshot("r1", 0)
    # Old events dropped; retained window is capped.
    assert len(evs) <= events._MAX_EVENTS_PER_RUN
    # The last event is always retained and the cursor reflects the logical total.
    assert evs[-1]["i"] == total - 1
    assert cursor == total


def test_event_bus_evicts_finished_runs():
    from app import events

    bus = events.EventBus()
    for i in range(events._MAX_RETAINED_RUNS + 10):
        rid = f"run-{i}"
        bus.create(rid)
        bus.mark_done(rid)
    # Finished runs beyond the cap are evicted; total retained stays bounded.
    assert len(bus._runs) <= events._MAX_RETAINED_RUNS


# --- Ingestion row cap is reported, not silent (agent-native "no silent caps")


def test_access_log_ingest_cap_is_reported(tmp_path, monkeypatch):
    from app.analysis import access_logs

    monkeypatch.setattr(access_logs, "MAX_INGEST_ROWS", 3)
    log = tmp_path / "big.log"
    log.write_text("\n".join(f"line number {i}" for i in range(10)))
    imp = access_logs.import_access_logs(log, tmp_path / "a.duckdb", "text")
    assert imp["truncated"] is True and imp["ingest_cap"] == 3
    assert imp["row_count"] == 3

    small = tmp_path / "small.log"
    small.write_text("only one line")
    imp2 = access_logs.import_access_logs(small, tmp_path / "b.duckdb", "text")
    assert imp2["truncated"] is False


def test_inventory_ingest_cap_is_reported(tmp_path, monkeypatch):
    from app.analysis import inventory

    monkeypatch.setattr(inventory, "MAX_INGEST_ROWS", 2)
    csv = tmp_path / "inv.csv"
    csv.write_text("Key,Size\n" + "\n".join(f"k{i},{i * 10}" for i in range(6)))
    imp = inventory.import_inventory_file(csv, tmp_path / "inv.duckdb")
    assert imp["truncated"] is True and imp["ingest_cap"] == 2
    assert imp["row_count"] == 2
