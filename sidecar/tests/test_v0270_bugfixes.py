"""Regression tests for the v0.27.0 "C3 de-ossification + hotfix" batch.

C3 — model-elastic budgets (agent depth scales to the model's context window,
never below the historical floor):
  - model_budget substring table + precedence + default → floor
  - a 1M-context model gets a proportionally deeper turn; a floor model is
    byte-for-byte unchanged (no regression)
  - _install_tool_output_budget honors the model-derived limit
  - _replay_tools keeps the TAIL (most recent) calls, not the head
  - the security-floor constants are UNCHANGED (snapshot guard)

Q1/Q2 — query_account_profile posture filters read the REAL persisted values:
  - access_issues matches access_denied/error, NOT a healthy "available" bucket
  - missing_logging/no_versioning match only confirmed-absent, not
    provider_unsupported / access_denied (unknown ≠ absent)

S-A/S-E — client_factory: anonymous (UNSIGNED) when no keys, path-style default
for a custom endpoint.

R-3 — CSV parser stops at the first recognized delimiter (no double read).
R-5 — redact() leaves benign non-UTF-8 bytes intact (only substitutes on a
      real secret match).
"""
import json
import sqlite3

import pytest

from app import config
from app.models.schemas import RunCreate
from app.repositories import account_discovery as account_repo
from app.repositories import runs as runs_repo


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


class _FT:  # minimal function_tool stand-in: keep the fn, tag its name
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


# ============================ C3: model_budget ==============================


def test_model_budget_context_window_precedence_and_default():
    from app.agent_runtime import model_budget as mb

    # Exact family lookups.
    assert mb.context_window("gpt-4o") == 128_000
    assert mb.context_window("gpt-4.1-mini") == 1_000_000  # more-specific first
    assert mb.context_window("claude-opus-4-8") == 200_000
    assert mb.context_window("gemini-2.0-flash") == 1_000_000
    # Unknown / empty → default (which yields exactly the historical floor).
    assert mb.context_window("some-unknown-model") == mb._DEFAULT_CONTEXT
    assert mb.context_window(None) == mb._DEFAULT_CONTEXT
    assert mb.context_window("") == mb._DEFAULT_CONTEXT


def test_model_budget_tool_output_never_below_floor():
    from app.agent_runtime import model_budget as mb

    # A 128k/200k model is unchanged: exactly the historical floor.
    assert mb.tool_output_char_budget("gpt-4o") == mb.TOOL_OUTPUT_CHARS_FLOOR
    assert mb.tool_output_char_budget("claude-opus-4-8") == mb.TOOL_OUTPUT_CHARS_FLOOR
    assert mb.tool_output_char_budget("unknown") == mb.TOOL_OUTPUT_CHARS_FLOOR
    # A 1M-context model scales up proportionally (0.25 * 1M tokens * 4 chars).
    assert mb.tool_output_char_budget("gpt-4.1") == 1_000_000
    # Never below floor, whatever the model.
    for m in (None, "", "tiny", "gpt-3.5-turbo", "qwen-max"):
        assert mb.tool_output_char_budget(m) >= mb.TOOL_OUTPUT_CHARS_FLOOR


def test_model_budget_completion_floor_and_ceiling():
    from app.agent_runtime import model_budget as mb

    # Floor model unchanged; large window raised but capped under provider max.
    assert mb.completion_token_budget("gpt-4o") == mb.COMPLETION_TOKENS_FLOOR
    assert mb.completion_token_budget("gpt-4.1") == mb.COMPLETION_TOKENS_CEILING
    for m in (None, "", "unknown", "claude-opus-4-8"):
        b = mb.completion_token_budget(m)
        assert mb.COMPLETION_TOKENS_FLOOR <= b <= mb.COMPLETION_TOKENS_CEILING


def test_install_tool_output_budget_honors_model_limit():
    from app.agent_runtime import model_budget as mb
    from app.agent_runtime import session_agent

    # No explicit limit → derived from the model. A 1M model must lift the cap
    # above the floor; a floor model must equal it.
    big = session_agent._install_tool_output_budget([], model="gpt-4.1")
    small = session_agent._install_tool_output_budget([], model="gpt-4o")
    assert big["limit"] == 1_000_000
    assert small["limit"] == mb.TOOL_OUTPUT_CHARS_FLOOR


def test_replay_tools_keeps_the_tail_not_the_head():
    from app.agent_runtime import session_agent

    # More calls than the replay cap: the summary must retain the MOST RECENT
    # ones (a truncated head would replay stale early probes and hide the latest).
    activity = [{"tool": f"probe_{i}", "args": {"n": i}, "ok": True}
                for i in range(session_agent._MAX_REPLAY_TOOLS + 10)]
    lines = session_agent._replay_tools(activity)
    joined = "\n".join(lines)
    assert "earlier tool calls this turn" in joined  # the elision marker
    last = f"probe_{session_agent._MAX_REPLAY_TOOLS + 9}"
    first = "probe_0"
    assert last in joined          # newest kept
    assert first not in joined     # oldest elided


def test_security_floor_constants_unchanged():
    """De-ossification lifts only the *arbitrary* depth constants. The security
    FLOOR (byte/list/sample/ingest caps) must stay pinned — this snapshot fails
    loudly if any of them is ever changed under the banner of 'de-ossification'."""
    from app.analysis import access_logs, aggregate
    from app.s3 import tools as s3_tools

    assert s3_tools.PREVIEW_MAX_BYTES == 1 * 1024 * 1024      # 1 MiB/preview
    assert s3_tools.MAX_RANGE_BYTES == 4 * 1024 * 1024        # 4 MiB/range read
    assert s3_tools.MAX_LIST_KEYS == 1000
    assert s3_tools.SAMPLE_KEYS_LIMIT == 20                   # rule 16
    assert access_logs.MAX_INGEST_ROWS == 2_000_000
    assert aggregate.MAX_GROUPS == 50 and aggregate.DEFAULT_GROUPS == 20


# ==================== Q1/Q2: query_account_profile filters ==================


def _seed(session_id, provider_id, buckets):
    """buckets: list of (name, access_status, config_flags_dict)."""
    from app.repositories import sessions as sessions_repo
    conn = _db()
    try:
        run_id = runs_repo.create(
            conn, RunCreate(run_type="account_discovery", provider_id=provider_id,
                            user_prompt="x", session_id=session_id), status="completed")
        sid = account_repo.create_snapshot(conn, run_id, provider_id, bucket_count=len(buckets),
                                           visible_count=len(buckets), processed_count=len(buckets),
                                           truncated=False, list_status="available", summary={})
        for name, access, flags in buckets:
            account_repo.add_bucket(conn, sid, run_id, provider_id, name, "us-east-1", access)
            account_repo.add_config_snapshot(conn, sid, run_id, provider_id, name, flags)
        sessions_repo.link_run(conn, session_id, run_id, "account_discovery")
        conn.commit()
        return run_id
    finally:
        conn.close()


def _query_tool(conn, session_id):
    from app.agent_runtime import session_action_tools
    tools = {t.name: t for t in session_action_tools.build(conn, _FT(), [], session_id=session_id)}
    return tools["query_account_profile"]


def _prov(client):
    return client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible", "endpoint_url": "https://m",
        "region": "us-east-1", "addressing_style": "path",
        "access_key": "AKIAIOSFODNN7EXAMPLE", "secret_key": "s"}).json()["id"]


def _sess(client, pid):
    return client.post("/sessions", json={
        "title": "t", "goal": "g", "provider_id": pid}).json()["id"]


def test_access_issues_does_not_match_healthy_buckets(client):
    pid = _prov(client)
    sid = _sess(client, pid)
    _seed(sid, pid, [
        ("healthy", "available", {"head_bucket_status": "available"}),
        ("denied", "access_denied", {"head_bucket_status": "access_denied"}),
        ("errored", "error", {"head_bucket_status": "error"}),
    ])
    conn = _db()
    try:
        tool = _query_tool(conn, sid)
        out = json.loads(tool(pid, "access_issues"))
        names = {b["bucket"] for b in out["buckets"]}
        # Only the genuinely broken buckets — the healthy "available" one is NOT
        # a match (the pre-fix bug matched every healthy bucket).
        assert names == {"denied", "errored"}
        assert "healthy" not in names
    finally:
        conn.close()


def test_missing_logging_and_versioning_ignore_unknown_states(client):
    pid = _prov(client)
    sid = _sess(client, pid)
    _seed(sid, pid, [
        ("absent", "available", {"logging_status": "not_configured",
                                 "versioning_status": "not_configured"}),
        ("present", "available", {"logging_status": "available",
                                  "versioning_status": "available"}),
        ("unsupported", "available", {"logging_status": "provider_unsupported",
                                      "versioning_status": "provider_unsupported"}),
        ("denied", "access_denied", {"logging_status": "access_denied",
                                     "versioning_status": "access_denied"}),
    ])
    conn = _db()
    try:
        tool = _query_tool(conn, sid)
        log = json.loads(tool(pid, "missing_logging"))
        ver = json.loads(tool(pid, "no_versioning"))
        # Only "confirmed absent" — provider_unsupported/access_denied are UNKNOWN,
        # not absent, so they must not be reported as missing.
        assert [b["bucket"] for b in log["buckets"]] == ["absent"]
        assert [b["bucket"] for b in ver["buckets"]] == ["absent"]
    finally:
        conn.close()


# ===================== S-A/S-E: client_factory =============================


def test_client_factory_anonymous_when_no_keys(client):
    """No keys configured → UNSIGNED (anonymous), never the host's ambient AWS
    identity; and a custom endpoint defaults to path-style addressing."""
    from botocore import UNSIGNED
    from app.s3 import client_factory

    # addressing_style explicitly unset (None) so the client_factory default —
    # NOT the schema's "virtual" default — is what's exercised. S-E must never
    # override an explicit stored choice, only fill in a genuinely-unset one.
    pid = client.post("/cloud-providers", json={
        "name": "anon", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": None}).json()["id"]
    conn = _db()
    try:
        c = client_factory.build_s3_client(conn, pid)
        assert c.meta.config.signature_version is UNSIGNED
        assert c.meta.config.s3["addressing_style"] == "path"  # custom endpoint default
        # No ambient credentials leaked in.
        assert c._request_signer._credentials is None
    finally:
        conn.close()


def test_client_factory_signs_when_keys_present(client):
    from botocore import UNSIGNED
    from app.s3 import client_factory

    pid = _prov(client)  # has access/secret keys
    conn = _db()
    try:
        c = client_factory.build_s3_client(conn, pid)
        assert c.meta.config.signature_version is not UNSIGNED
        assert c._request_signer._credentials is not None
    finally:
        conn.close()


# ============================ R-3: CSV single-read =========================


def test_csv_parser_recognizes_comma_header(tmp_path):
    from app.analysis import access_logs

    src = tmp_path / "log.csv"
    src.write_text("timestamp,method,key,status,bytes\n"
                   "2026-07-01T10:00:00Z,GET,a/b.txt,200,10\n"
                   "2026-07-01T10:00:01Z,GET,a/c.txt,404,20\n")
    rows = access_logs._parse_csv(src)
    assert len(rows) == 2
    assert rows[0]["status_code"] == 200  # _row coerces status to int
    assert rows[0]["method"] == "GET"


def test_csv_parser_recognizes_tab_header(tmp_path):
    from app.analysis import access_logs

    src = tmp_path / "log.tsv"
    src.write_text("timestamp\tmethod\tkey\tstatus\n"
                   "2026-07-01T10:00:00Z\tPUT\tx/y\t201\n")
    rows = access_logs._parse_csv(src)
    assert len(rows) == 1 and rows[0]["method"] == "PUT" and rows[0]["status_code"] == 201


# ============================ R-5: bytes redaction =========================


def test_redact_bytes_preserves_benign_binary():
    from app.security.redaction import redact

    # Non-UTF-8 bytes with no secret → returned UNCHANGED (no lossy U+FFFD).
    blob = bytes([0x00, 0xFF, 0xFE, 0x80, 0x81, 0x01, 0x02])
    assert redact(blob) == blob
    assert redact({"body": blob})["body"] == blob


def test_redact_bytes_still_scrubs_a_real_secret():
    from app.security.redaction import redact, REDACTED

    secret = b"aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    out = redact(secret)
    assert isinstance(out, bytes)
    text = out.decode("utf-8", "replace")
    assert "wJalrXUtnFEMI" not in text  # the secret value is gone
