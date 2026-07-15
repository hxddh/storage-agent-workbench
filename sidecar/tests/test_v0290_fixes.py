"""Tests for the v0.29.0 correction + coverage batch.

P0 — policy_status semantics: GetBucketPolicyStatus.IsPublic is POLICY-only; the
     review must not emit a false "Not public" verdict on an ACL-public bucket,
     and must not assert any overall verdict when the ACL is unreadable.
P0 — the evidence-imports plan endpoint maps CredentialResolutionError to an
     actionable 424 instead of a raw 500.
P0 — max-output table: gemini-2.5 / deepseek-reasoner are no longer clamped to
     8k; a stale session-token ref on a keyless provider no longer errors.
Survey — public-posture flags persist and the public_buckets filter works.
Triage — InvalidObjectState / dotted KMS codes / orphaned known codes resolve.
Micro — budget ceiling, elastic user-msg cap, drift syncs, context_window
        clearable via 0, truncated-PEM redaction, DuckDB lock message, client
        cache identity + invalidation.
"""
import json
import sqlite3
from typing import Any

import pytest
from botocore.exceptions import ClientError

from app import config
from app.models.schemas import RunCreate
from app.repositories import account_discovery as account_repo
from app.repositories import runs as runs_repo
from app.s3 import client_factory
from app.s3 import config_tools as ct

ALL_USERS = "http://acs.amazonaws.com/groups/global/AllUsers"


def _err(code: str, http: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": code}, "ResponseMetadata": {"HTTPStatusCode": http}},
        "Get")


class FakeS3:
    def __init__(self, behaviors: dict[str, Any]):
        self.behaviors = behaviors

    def __getattr__(self, method):
        def _call(**kwargs):
            beh = self.behaviors.get(method)
            if isinstance(beh, ClientError):
                raise beh
            if beh is None:
                raise _err("NotImplemented", 501)
            return beh
        return _call


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


def _provider(client, **extra):
    return client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAEXAMPLE", "secret_key": "shhh",
        **extra}).json()["id"]


# =================== P0: policy_status is policy-only =======================


def test_no_false_not_public_on_acl_public_bucket(client, monkeypatch):
    """Policy says not-public but the ACL grants AllUsers: the review must NOT
    emit a GOOD 'Not public' — the bucket IS publicly exposed via its ACL."""
    pid = _provider(client)
    fake = FakeS3({
        "get_bucket_policy": _err("NoSuchBucketPolicy"),
        "get_bucket_cors": _err("NoSuchCORSConfiguration"),
        "get_bucket_encryption": {"ServerSideEncryptionConfiguration": {"Rules": [{}]}},
        "get_bucket_acl": {"Grants": [{"Grantee": {"URI": ALL_USERS, "Type": "Group"},
                                       "Permission": "READ"}]},
        "get_public_access_block": _err("NoSuchPublicAccessBlockConfiguration"),
        "get_bucket_policy_status": {"PolicyStatus": {"IsPublic": False}},
        "get_bucket_ownership_controls": _err("OwnershipControlsNotFoundError"),
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _db()
    try:
        out = ct.review_bucket_security(conn, pid, "b")
        facts = out["facts"]
        assert facts["policy_is_public"] is False
        assert facts["acl_public"] is True
        assert facts["publicly_exposed"] is True  # combined verdict: exposed
        titles = [f["title"] for f in out["findings"]]
        assert not any("Not public" in t for t in titles)
        assert any("ACL grants public access" in t for t in titles)
    finally:
        conn.close()


def test_no_overall_verdict_when_acl_unreadable(client, monkeypatch):
    """Policy not-public but ACL access-denied: no overall verdict may be
    asserted — the pre-fix code emitted a false-negative GOOD here."""
    pid = _provider(client)
    fake = FakeS3({
        "get_bucket_policy": _err("NoSuchBucketPolicy"),
        "get_bucket_cors": _err("NoSuchCORSConfiguration"),
        "get_bucket_encryption": {"ServerSideEncryptionConfiguration": {"Rules": [{}]}},
        "get_bucket_acl": _err("AccessDenied", 403),
        "get_public_access_block": _err("NoSuchPublicAccessBlockConfiguration"),
        "get_bucket_policy_status": {"PolicyStatus": {"IsPublic": False}},
        "get_bucket_ownership_controls": _err("OwnershipControlsNotFoundError"),
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _db()
    try:
        out = ct.review_bucket_security(conn, pid, "b")
        assert out["facts"]["publicly_exposed"] is None  # indeterminate, not GOOD
        titles = [f["title"] for f in out["findings"]]
        assert not any("Not public (policy verdict + ACL check)" in t for t in titles)
        assert any("ACL unreadable" in t for t in titles)
    finally:
        conn.close()


def test_clean_bucket_gets_combined_not_public(client, monkeypatch):
    pid = _provider(client)
    fake = FakeS3({
        "get_bucket_policy": _err("NoSuchBucketPolicy"),
        "get_bucket_cors": _err("NoSuchCORSConfiguration"),
        "get_bucket_encryption": {"ServerSideEncryptionConfiguration": {"Rules": [{}]}},
        "get_bucket_acl": {"Grants": []},
        "get_public_access_block": {"PublicAccessBlockConfiguration": {
            "BlockPublicAcls": True, "IgnorePublicAcls": True,
            "BlockPublicPolicy": True, "RestrictPublicBuckets": True}},
        "get_bucket_policy_status": {"PolicyStatus": {"IsPublic": False}},
        "get_bucket_ownership_controls": {
            "OwnershipControls": {"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]}},
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _db()
    try:
        out = ct.review_bucket_security(conn, pid, "b")
        assert out["facts"]["publicly_exposed"] is False
        assert any("Not public (policy verdict + ACL check)" in f["title"]
                   for f in out["findings"])
    finally:
        conn.close()


# ============ P0: plan endpoint maps credential errors to 424 ===============


def test_plan_endpoint_maps_missing_vault_credential_to_424(client):
    from app.security import keyring_store
    pid = _provider(client)
    conn = _db()
    try:
        run_id = runs_repo.create(
            conn, RunCreate(run_type="account_discovery", provider_id=pid, user_prompt="x"),
            status="completed")
        sid = account_repo.create_snapshot(
            conn, run_id, pid, bucket_count=1, visible_count=1, processed_count=1,
            truncated=False, list_status="available", summary={})
        account_repo.add_bucket(conn, sid, run_id, pid, "biz", "us-east-1", "available")
        account_repo.add_config_snapshot(conn, sid, run_id, pid, "biz", {})
        account_repo.add_evidence_source(conn, sid, run_id, pid, "biz", {
            "source_type": "inventory", "status": "available", "configured": True,
            "configurations": [{"inventory_id": "inv1", "destination_bucket": "inv-dest",
                                "destination_prefix": "inv/", "format": "CSV"}]})
        conn.commit()
    finally:
        conn.close()
    # Simulate the out-of-sync vault the error targets.
    keyring_store.delete_secret("cloud_provider", f"{pid}/secret_key")
    r = client.post("/evidence-imports/plan", json={
        "account_run_id": run_id, "bucket_name": "biz", "source_type": "inventory"})
    assert r.status_code == 424  # actionable, sanitized — NOT a raw 500
    assert "vault" in r.json()["detail"].lower()


# ================= P0: max-output table + token-only ref ===================


def test_max_output_table_gemini25_and_deepseek_reasoner():
    from app.agent_runtime import model_budget as mb
    assert mb.max_output_tokens("gemini-2.5-pro") == 64_000
    assert mb.max_output_tokens("gemini-2.0-flash") == 8_192
    assert mb.max_output_tokens("deepseek-reasoner") == 64_000
    assert mb.max_output_tokens("deepseek-chat") == 8_192
    # gemini-2.5 (1M window): scaled 32768, no longer clamped to 8192.
    assert mb.completion_token_budget("gemini-2.5-pro") == 32_768


def test_stale_token_ref_on_keyless_provider_stays_anonymous(client):
    from botocore import UNSIGNED
    from app.security import keyring_store
    pid = client.post("/cloud-providers", json={
        "name": "tok-only", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "session_token": "stale-token"}).json()["id"]
    keyring_store.delete_secret("cloud_provider", f"{pid}/session_token")
    conn = _db()
    try:
        # The token could never be used (no access/secret key) — must NOT raise.
        c = client_factory.build_s3_client(conn, pid)
        assert c.meta.config.signature_version is UNSIGNED
    finally:
        conn.close()


# ===================== Survey: public posture flags ========================


def test_survey_snapshot_carries_public_posture(client, monkeypatch):
    from app.s3 import account_tools
    pid = _provider(client)
    fake = FakeS3({
        "get_bucket_location": {"LocationConstraint": "us-east-1"},
        "get_bucket_versioning": {"Status": "Enabled"},
        "get_bucket_encryption": {"ServerSideEncryptionConfiguration": {"Rules": [{}]}},
        "get_bucket_lifecycle_configuration": _err("NoSuchLifecycleConfiguration"),
        "get_bucket_logging": {},
        "get_bucket_replication": _err("ReplicationConfigurationNotFoundError"),
        "get_bucket_policy": {"Policy": "{}"},
        "get_public_access_block": _err("NoSuchPublicAccessBlockConfiguration"),
        "get_bucket_tagging": _err("NoSuchTagSet"),
        "list_bucket_inventory_configurations": {},
        "get_bucket_policy_status": {"PolicyStatus": {"IsPublic": True}},
        "get_bucket_ownership_controls": {
            "OwnershipControls": {"Rules": [{"ObjectOwnership": "ObjectWriter"}]}},
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _db()
    try:
        snap = account_tools.get_bucket_config_snapshot(conn, pid, "b")
        assert snap["policy_is_public"] is True
        assert snap["object_ownership"] == "ObjectWriter"
        assert snap["acls_disabled"] is False
    finally:
        conn.close()


def test_query_account_profile_public_buckets_filter(client):
    from app.agent_runtime import session_action_tools
    from app.repositories import sessions as sessions_repo

    class _FT:
        def __call__(self, fn):
            fn.name = fn.__name__
            return fn

    pid = _provider(client)
    ses = client.post("/sessions", json={"title": "t", "goal": "g", "provider_id": pid}).json()["id"]
    conn = _db()
    try:
        run_id = runs_repo.create(
            conn, RunCreate(run_type="account_discovery", provider_id=pid,
                            user_prompt="x", session_id=ses), status="completed")
        sid = account_repo.create_snapshot(conn, run_id, pid, bucket_count=3,
                                           visible_count=3, processed_count=3,
                                           truncated=False, list_status="available", summary={})
        for name, flags in (
            ("open-bucket", {"policy_is_public": True, "policy_public_status": "available"}),
            ("closed-bucket", {"policy_is_public": False, "policy_public_status": "available"}),
            ("unknown-bucket", {"policy_is_public": None, "policy_public_status": "access_denied"}),
        ):
            account_repo.add_bucket(conn, sid, run_id, pid, name, "us-east-1", "available")
            account_repo.add_config_snapshot(conn, sid, run_id, pid, name, flags)
        sessions_repo.link_run(conn, ses, run_id, "account_discovery")
        conn.commit()
        tools = {t.name: t for t in session_action_tools.build(conn, _FT(), [], session_id=ses)}
        out = json.loads(tools["query_account_profile"](pid, "public_buckets"))
        assert [b["bucket"] for b in out["buckets"]] == ["open-bucket"]
    finally:
        conn.close()


def test_diff_aspects_include_public_posture():
    assert "policy_is_public" in account_repo._DIFF_ASPECTS
    assert "object_ownership" in account_repo._DIFF_ASPECTS


# =========================== Triage additions ==============================


def test_triage_invalid_object_state_and_kms():
    from app.error_triage import parser, playbooks
    p = parser.parse("<Code>InvalidObjectState</Code> The operation is not valid "
                     "for the object's storage class")
    assert p["error_code"] == "InvalidObjectState"
    m = playbooks.match(p)
    assert "archived" in m[0]["title"].lower()
    assert any("head_object" in c for c in m[0]["next_checks"])

    p2 = parser.parse("An error occurred (KMS.AccessDenied) when calling GetObject")
    assert p2["error_code"] == "KMS.AccessDenied"
    assert "KMS" in playbooks.match(p2)[0]["title"]


def test_triage_orphaned_codes_now_resolve():
    from app.error_triage import parser, playbooks
    for code in ("ServiceUnavailable", "Throttling", "InternalError", "BadGateway",
                 "ExpiredToken", "InvalidToken", "NotImplemented", "MethodNotAllowed"):
        m = playbooks.match(parser.parse(f"error: {code} occurred"))
        assert m[0]["code"] == code, code
        assert m[0]["title"] != "Could not classify the error deterministically"


# ============================ Micro-batch ==================================


def test_tool_output_budget_has_ceiling():
    from app.agent_runtime import model_budget as mb
    # An absurd operator-declared window can't create an unbounded budget.
    assert mb.tool_output_char_budget("x", explicit_window=100_000_000) == mb.TOOL_OUTPUT_CHARS_CEILING


def test_drift_syncs():
    from app.agent_runtime import session_agent as sa
    from app.sessions import summary_builder as sb
    assert sa._MAX_FINDINGS == sb.MAX_FINDINGS
    assert sa._MAX_REPLAY_TOOLS == sa._MAX_TURNS


def test_context_window_clearable_via_zero(client):
    pid = client.post("/model-providers", json={
        "name": "m", "provider_type": "openai", "model": "gpt-4o",
        "api_key": "sk-test", "context_window": 500000}).json()["id"]
    assert client.get("/model-providers").json()[0]["context_window"] == 500000
    r = client.patch(f"/model-providers/{pid}", json={"context_window": 0})
    if r.status_code == 405:  # PATCH vs PUT — use whichever the API exposes
        r = client.put(f"/model-providers/{pid}", json={"context_window": 0})
    assert r.status_code == 200
    assert r.json()["context_window"] is None


def test_truncated_pem_is_redacted():
    from app.security.redaction import redact_text
    partial = ("-----BEGIN RSA PRIVATE KEY-----\n"
               "MIIEowIBAAKCAQEA7yzMx3P8XBz3n1Qq\nSECRETSECRETSECRET")  # no END armor
    out = redact_text(partial)
    assert "SECRETSECRET" not in out and "MIIEow" not in out
    # A full block still redacts (regression guard for rule ordering).
    full = ("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- trailing")
    assert "abc" not in redact_text(full) and "trailing" in redact_text(full)


def test_duckdb_lock_becomes_friendly_error(tmp_path, monkeypatch):
    import duckdb as _duckdb
    from app.analysis import duck
    db = tmp_path / "a.duckdb"
    db.write_bytes(b"")  # exists → read-only path taken
    def _boom(*a, **k):
        raise _duckdb.IOException("Could not set lock on file: held by another process")
    monkeypatch.setattr(duck.duckdb, "connect", _boom)
    with pytest.raises(ValueError, match="busy"):
        duck.connect(db, read_only=True)


def test_client_cache_identity_and_invalidation(client):
    pid = _provider(client)
    conn = _db()
    try:
        c1 = client_factory.build_s3_client(conn, pid)
        c2 = client_factory.build_s3_client(conn, pid)
        assert c1 is c2  # cached
        # An update invalidates the cached client (explicit invalidation +
        # updated_at key rotation) → a fresh client, no stale config served.
        r = client.patch(f"/cloud-providers/{pid}", json={"region": "eu-west-1"})
        if r.status_code == 405:
            r = client.put(f"/cloud-providers/{pid}", json={"region": "eu-west-1"})
        assert r.status_code == 200
        c3 = client_factory.build_s3_client(conn, pid)
        assert c3 is not c1
    finally:
        conn.close()


def test_elastic_user_msg_cap():
    from app.agent_runtime import model_budget as mb
    from app.agent_runtime import session_agent as sa
    # Recompute the cap exactly as _build_prompt does.
    for model, expect in (("gpt-4o", sa._MAX_USER_MSG), ("gpt-4.1", sa._MAX_USER_MSG_CEIL)):
        window = mb.context_window(model)
        cap = min(sa._MAX_USER_MSG_CEIL, sa._MAX_USER_MSG * max(1, window // 128_000))
        assert cap == expect, model
