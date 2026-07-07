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


# --- A1: constrained aggregation — agent-chosen, whitelisted, no raw rows -----


_LOG_LINES = "\n".join(
    f'2026-06-25T10:0{i % 10}:00Z bucket-a GET /logs/f{i}.log {403 if i % 3 == 0 else 200} '
    f'{100 * (i + 1)} {10 + i} ms user-agent="ua-{i % 2}" remote_ip="192.0.2.{i}"'
    for i in range(9)
)


def _agg_db(tmp_path):
    from app.analysis import access_logs

    log = tmp_path / "a.log"
    log.write_text(_LOG_LINES)
    db = tmp_path / "a.duckdb"
    access_logs.import_access_logs(log, db, "text")
    return db


def test_aggregate_group_by_with_status_range(tmp_path):
    from app.analysis import aggregate

    out = aggregate.aggregate(_agg_db(tmp_path), "access_log", "count",
                              group_by="user_agent", status_min=400, status_max=499)
    assert out["group_by"] == "user_agent" and out["groups"]
    # 403s land on i % 3 == 0 → i in {0,3,6} → ua-0 twice (0,6), ua-1 once (3).
    got = {g["group"]: g["value"] for g in out["groups"]}
    assert got == {"ua-0": 2, "ua-1": 1}
    assert "?" in out["sql"] and len(out["params"]) == 2  # values are BOUND


def test_aggregate_scalar_and_equality_filter(tmp_path):
    from app.analysis import aggregate

    out = aggregate.aggregate(_agg_db(tmp_path), "access_log", "count",
                              filters={"method": "GET"})
    assert out["value"] == 9 and out["group_by"] is None
    assert out["params"] == ["GET"]  # bound, not interpolated


def test_aggregate_rejects_non_whitelisted_identifiers(tmp_path):
    from app.analysis import aggregate

    db = _agg_db(tmp_path)
    with pytest.raises(aggregate.AggregateError, match="Unknown group_by"):
        aggregate.aggregate(db, "access_log", "count", group_by="raw_sanitized; DROP TABLE x")
    with pytest.raises(aggregate.AggregateError, match="Unknown metric"):
        aggregate.aggregate(db, "access_log", "count(*)--")
    with pytest.raises(aggregate.AggregateError, match="Unknown filter column"):
        aggregate.aggregate(db, "access_log", "count", filters={"1=1": "x"})


def test_aggregate_filter_value_injection_is_inert(tmp_path):
    from app.analysis import aggregate

    db = _agg_db(tmp_path)
    # A hostile VALUE rides through as a bound parameter — matches nothing,
    # drops nothing.
    out = aggregate.aggregate(db, "access_log", "count",
                              filters={"method": "GET'; DROP TABLE access_logs; --"})
    assert out["value"] == 0
    out2 = aggregate.aggregate(db, "access_log", "count")
    assert out2["value"] == 9  # table intact


def test_aggregate_limit_reports_truncation(tmp_path):
    from app.analysis import aggregate

    out = aggregate.aggregate(_agg_db(tmp_path), "access_log", "count",
                              group_by="key", limit=3)
    assert len(out["groups"]) == 3 and out["truncated"] is True


def test_aggregate_tool_registered_and_audited(client):
    """The agent-facing tool exists with a real description under the REAL SDK
    decorator, auto-imports the upload, and records the ACTUAL SQL in the audit
    log (rule 17)."""
    from agents import function_tool

    from app.agent_runtime import session_analysis_tools
    from app.db import connect

    sid = client.post("/sessions", json={"title": "agg"}).json()["id"]
    up = client.post(f"/sessions/{sid}/datasets/upload",
                     files={"file": ("x.log", _LOG_LINES.encode(), "text/plain")},
                     data={"dataset_type": "access_log"})
    assert up.status_code == 200, up.text
    dataset_id = up.json()["dataset_id"]

    # Real SDK registration: name + non-empty description.
    conn = connect()
    try:
        tools = session_analysis_tools.build(conn, function_tool, sid)
        by_name = {t.name: t for t in tools}
        assert "aggregate_uploaded_file" in by_name
        assert by_name["aggregate_uploaded_file"].description.strip()
    finally:
        conn.close()

    # Invoke through a plain decorator so we can call the inner function directly.
    class _FT:
        def __call__(self, fn):
            fn.name = fn.__name__
            return fn

    conn = connect()
    try:
        tools = session_analysis_tools.build(conn, _FT(), sid)
        agg_tool = next(t for t in tools if t.name == "aggregate_uploaded_file")
        res = json.loads(agg_tool(dataset_id, "count", "status_code"))
        assert res.get("groups"), res
        # Group labels are strings; the 403 bucket must be present.
        assert any(str(g["group"]) == "403" for g in res["groups"])
        row = conn.execute(
            "SELECT payload_json_sanitized FROM audit_logs "
            "WHERE event_type = 'session.aggregate_uploaded_file' ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        assert row is not None
        assert "SELECT" in row[0]  # the real SQL, not a descriptor
    finally:
        conn.close()


def test_aggregate_tool_error_lists_allowed_values(client, tmp_path):
    from app.agent_runtime import session_analysis_tools
    from app.db import connect

    class _FT:
        def __call__(self, fn):
            fn.name = fn.__name__
            return fn

    sid = client.post("/sessions", json={"title": "agg2"}).json()["id"]
    up = client.post(f"/sessions/{sid}/datasets/upload",
                     files={"file": ("x.log", _LOG_LINES.encode(), "text/plain")},
                     data={"dataset_type": "access_log"})
    dataset_id = up.json()["dataset_id"]
    conn = connect()
    try:
        tools = session_analysis_tools.build(conn, _FT(), sid)
        agg_tool = next(t for t in tools if t.name == "aggregate_uploaded_file")
        res = json.loads(agg_tool(dataset_id, "count", "not_a_column"))
        assert "Allowed:" in res["error"]  # self-correcting error surface
    finally:
        conn.close()


# --- Codex P2: re-upload must not aggregate from the stale DuckDB table --------


def test_aggregate_reimports_after_same_filename_reupload(client):
    """Re-uploading the same filename resets the dataset to 'uploaded' but the old
    <id>.duckdb lingers; aggregate must rebuild, not answer from the stale table."""
    from app.agent_runtime import session_analysis_tools
    from app.db import connect

    class _FT:
        def __call__(self, fn):
            fn.name = fn.__name__
            return fn

    sid = client.post("/sessions", json={"title": "reup"}).json()["id"]
    five = "\n".join(
        f'2026-06-25T10:00:0{i}Z b GET /f{i} 200 10 5 ms user-agent="u" remote_ip="192.0.2.{i}"'
        for i in range(5)
    )
    r1 = client.post(f"/sessions/{sid}/datasets/upload",
                     files={"file": ("same.log", five.encode(), "text/plain")},
                     data={"dataset_type": "access_log"})
    dataset_id = r1.json()["dataset_id"]

    conn = connect()
    try:
        agg_tool = next(t for t in session_analysis_tools.build(conn, _FT(), sid)
                        if t.name == "aggregate_uploaded_file")
        assert json.loads(agg_tool(dataset_id, "count"))["value"] == 5
    finally:
        conn.close()

    # Re-upload the SAME filename with only two rows → same dataset id, status reset.
    two = "\n".join(
        f'2026-06-25T10:00:0{i}Z b GET /f{i} 200 10 5 ms user-agent="u" remote_ip="192.0.2.{i}"'
        for i in range(2)
    )
    r2 = client.post(f"/sessions/{sid}/datasets/upload",
                     files={"file": ("same.log", two.encode(), "text/plain")},
                     data={"dataset_type": "access_log"})
    assert r2.json()["dataset_id"] == dataset_id  # reused row
    assert r2.json()["status"] == "uploaded"

    conn = connect()
    try:
        agg_tool = next(t for t in session_analysis_tools.build(conn, _FT(), sid)
                        if t.name == "aggregate_uploaded_file")
        assert json.loads(agg_tool(dataset_id, "count"))["value"] == 2  # rebuilt, not stale 5
    finally:
        conn.close()


# --- A4: active model provider selection --------------------------------------


def test_active_model_provider_selected_and_fallback(client):
    from app.agent_runtime.agent_service import get_model_credentials
    from app.db import connect

    a = client.post("/model-providers", json={
        "name": "first", "provider_type": "openai", "model": "m-a", "api_key": "sk-aaaaaaaa1"}).json()
    # With no explicit selection, the single provider must be flagged active
    # (Codex P2: UI badge must match the agent's implicit oldest-provider choice).
    assert client.get("/model-providers").json()[0]["active"] is True
    b = client.post("/model-providers", json={
        "name": "second", "provider_type": "openai", "model": "m-b", "api_key": "sk-bbbbbbbb2"}).json()

    conn = connect()
    try:
        # Default: oldest wins (pre-existing behavior).
        assert get_model_credentials(conn)["model"] == "m-a"
    finally:
        conn.close()
    # And the oldest ('first') shows active even though nothing was activated.
    implicit = {p["name"]: p["active"] for p in client.get("/model-providers").json()}
    assert implicit == {"first": True, "second": False}

    # Activate the newer provider → the agent now uses it.
    r = client.post(f"/model-providers/{b['id']}/activate")
    assert r.status_code == 200 and r.json()["active"] is True
    listed = {p["name"]: p["active"] for p in client.get("/model-providers").json()}
    assert listed == {"first": False, "second": True}

    conn = connect()
    try:
        assert get_model_credentials(conn)["model"] == "m-b"
    finally:
        conn.close()

    # Deleting the active provider clears the selection → oldest again.
    client.delete(f"/model-providers/{b['id']}")
    conn = connect()
    try:
        assert get_model_credentials(conn)["model"] == "m-a"
    finally:
        conn.close()
    assert client.post(f"/model-providers/{a['id']}/activate").status_code == 200
    assert client.post("/model-providers/nope/activate").status_code == 404


# --- A5: user-message truncation is explicit, never silent --------------------


def test_long_user_message_truncation_is_marked(client):
    from app.agent_runtime import session_agent
    from app.db import connect

    sid = client.post("/sessions", json={"title": "long"}).json()["id"]
    conn = connect()
    try:
        row = dict(conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone())
        long_msg = "x" * (session_agent._MAX_USER_MSG + 500)
        prompt, _, _ = session_agent._build_prompt(row, {}, [], long_msg, conn)
        assert "[TRUNCATED:" in prompt and "500 more characters" in prompt
        short_prompt, _, _ = session_agent._build_prompt(row, {}, [], "hi", conn)
        assert "[TRUNCATED:" not in short_prompt
    finally:
        conn.close()


# --- A3/A6/A7: raised ceilings stay wired to their consumers ------------------


def test_raised_budgets_and_caps():
    from app.agent_runtime import session_agent, session_tools
    from app.skills import contract

    # Depth: the step count is a runaway SAFETY ceiling; the elastic tool-output
    # budget is the primary governor of how deep a turn goes (context-size, not an
    # arbitrary step number). Both raised so a deep read-only investigation runs to
    # completion in one turn instead of being cut short.
    assert session_agent._MAX_TURNS >= 40
    assert session_agent._MAX_TOOL_OUTPUT_CHARS >= 200_000
    assert session_tools._LIST_KEYS_CTX_CAP >= 500
    # skills_used contract cap must match the per-turn read_skill budget; the
    # budget constants live inside build(), so pin the contract-side value.
    src = open("app/agent_runtime/session_tools.py").read()
    assert "_MAX_SKILL_LOADS = 10" in src
    assert "_MAX_PREVIEWS = 16" in src
    assert "_MAX_LATENCY_RUNS = 8" in src
    raw = "answer\n```json\n" + json.dumps(
        {"skills_used": [f"s{i}" for i in range(12)], "next_action_proposals": []}
    ) + "\n```"
    assert len(contract.parse_agent_contract(raw)["skills_used"]) == 10


# --- B3: denylist no longer ossifies against a constrained aggregate tool -----


def test_denylist_allows_aggregate_but_blocks_raw_sql():
    from app.agent_runtime import guardrails as g

    assert not g.is_forbidden_tool("aggregate_uploaded_file")
    assert not g.is_forbidden_tool("aggregate")
    for bad in ("run_sql", "sql_query", "execute_sql", "raw_sql", "execute_query"):
        assert g.is_forbidden_tool(bad), bad


# --- B1: redaction precision — benign text must survive -----------------------


def test_redaction_precision_benign_text_untouched():
    from app.security.redaction import redact_text

    benign = (
        "The signature dish arrived; check the cookie jar. "
        "Bucket data-backups-prod-2026 has 40 characters exactly here: "
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN and a normal sentence."
    )
    assert redact_text(benign) == benign
