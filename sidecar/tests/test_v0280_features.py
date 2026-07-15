"""Tests for the v0.28.0 feature/hardening batch.

A1/A2 — authoritative public-posture visibility:
  - get_bucket_config_detail exposes policy_status (IsPublic), ownership
    (ObjectOwnership / ACLs-disabled), object_lock (bucket WORM default), and acl
    (grantee KIND + permission, no owner id/email).
  - review_bucket_security folds in the authoritative IsPublic verdict + Object
    Ownership.

B1 — model-budget de-ossification:
  - an operator-declared context_window overrides the substring table.
  - completion budget is clamped to the model's real provider max-output (closes
    the latent 400 on gpt-4-turbo / gemini), while unknown models keep the floor.

B2 — elastic thread-replay caps scale with the window, floored + capped.

CF — a configured-but-unresolvable credential raises instead of silently going
     anonymous.

CSV — a TSV whose header cell contains a comma still parses via tab (no regression
      from the v0.27.0 early-break).
"""
import sqlite3
from typing import Any

import pytest
from botocore.exceptions import ClientError

from app import config
from app.s3 import client_factory
from app.s3 import config_tools as ct

ALL_USERS = "http://acs.amazonaws.com/groups/global/AllUsers"
LOG_DELIVERY = "http://acs.amazonaws.com/groups/s3/LogDelivery"


def _err(code: str, http: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": code}, "ResponseMetadata": {"HTTPStatusCode": http}},
        "Get")


class FakeS3:
    def __init__(self, behaviors: dict[str, Any]):
        self.behaviors = behaviors
        self.calls: list[tuple[str, dict]] = []

    def __getattr__(self, method):
        def _call(**kwargs):
            self.calls.append((method, kwargs))
            beh = self.behaviors.get(method)
            if isinstance(beh, ClientError):
                raise beh
            if beh is None:
                raise _err("NotImplemented", 501)
            return beh
        return _call


def _provider(client):
    return client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAEXAMPLE", "secret_key": "shhh"}).json()["id"]


def _conn():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


# ==================== A1/A2: config detail aspects ==========================


def test_new_detail_aspects_registered():
    for aspect in ("policy_status", "ownership", "object_lock", "acl"):
        assert aspect in ct._DETAIL_ASPECTS
        assert aspect in ct._DETAIL_EXTRACTORS


def test_detail_policy_status_is_public(client, monkeypatch):
    pid = _provider(client)
    fake = FakeS3({"get_bucket_policy_status": {"PolicyStatus": {"IsPublic": True}}})
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _conn()
    try:
        out = ct.get_bucket_config_detail(conn, pid, "b", "policy_status")
        assert out["status"] == "available"
        assert out["rules"] == [{"is_public": True}]
    finally:
        conn.close()


def test_detail_ownership_acls_disabled(client, monkeypatch):
    pid = _provider(client)
    fake = FakeS3({"get_bucket_ownership_controls": {
        "OwnershipControls": {"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]}}})
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _conn()
    try:
        out = ct.get_bucket_config_detail(conn, pid, "b", "ownership")
        assert out["rules"] == [{"object_ownership": "BucketOwnerEnforced", "acls_disabled": True}]
    finally:
        conn.close()


def test_detail_object_lock_default_retention(client, monkeypatch):
    pid = _provider(client)
    fake = FakeS3({"get_object_lock_configuration": {"ObjectLockConfiguration": {
        "ObjectLockEnabled": "Enabled",
        "Rule": {"DefaultRetention": {"Mode": "COMPLIANCE", "Days": 30}}}}})
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _conn()
    try:
        out = ct.get_bucket_config_detail(conn, pid, "b", "object_lock")
        assert out["rules"] == [{"object_lock_enabled": True, "default_mode": "COMPLIANCE",
                                 "default_retention_days": 30, "default_retention_years": None}]
    finally:
        conn.close()


def test_detail_acl_grantee_kinds_no_owner_leak(client, monkeypatch):
    pid = _provider(client)
    fake = FakeS3({"get_bucket_acl": {
        "Owner": {"ID": "CANONICAL-OWNER-SHOULD-NOT-LEAK", "DisplayName": "acct-alice"},
        "Grants": [
            {"Grantee": {"URI": ALL_USERS, "Type": "Group"}, "Permission": "READ"},
            {"Grantee": {"URI": LOG_DELIVERY, "Type": "Group"}, "Permission": "WRITE"},
            {"Grantee": {"ID": "SOME-CANONICAL-ID", "Type": "CanonicalUser"}, "Permission": "FULL_CONTROL"},
        ]}})
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _conn()
    try:
        out = ct.get_bucket_config_detail(conn, pid, "b", "acl")
        kinds = {(r["grantee_kind"], r["permission"]) for r in out["rules"]}
        assert kinds == {("public-all-users", "READ"), ("log-delivery", "WRITE"),
                         ("canonical-user", "FULL_CONTROL")}
        blob = str(out)
        assert "CANONICAL-OWNER-SHOULD-NOT-LEAK" not in blob and "SOME-CANONICAL-ID" not in blob
    finally:
        conn.close()


def test_security_review_surfaces_authoritative_is_public(client, monkeypatch):
    pid = _provider(client)
    fake = FakeS3({
        "get_bucket_policy": _err("NoSuchBucketPolicy"),
        "get_bucket_cors": _err("NoSuchCORSConfiguration"),
        "get_bucket_encryption": {"ServerSideEncryptionConfiguration": {"Rules": [{}]}},
        "get_bucket_acl": {"Grants": []},
        "get_public_access_block": _err("NoSuchPublicAccessBlockConfiguration"),
        "get_bucket_policy_status": {"PolicyStatus": {"IsPublic": True}},
        "get_bucket_ownership_controls": {
            "OwnershipControls": {"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]}},
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _conn()
    try:
        out = ct.review_bucket_security(conn, pid, "b")
        facts = out["facts"]
        assert facts["is_public"] is True
        assert facts["object_ownership"] == "BucketOwnerEnforced"
        assert facts["acls_disabled"] is True
        titles = " ".join(f["title"] for f in out["findings"])
        assert "PUBLIC" in titles and "ACLs disabled" in titles
    finally:
        conn.close()


# ======================= B1: model_budget ==================================


def test_explicit_context_window_overrides_table():
    from app.agent_runtime import model_budget as mb
    # A model the table would peg at 128k, declared as 1M by the operator.
    assert mb.context_window("some-new-model") == 128_000
    assert mb.context_window("some-new-model", explicit=1_000_000) == 1_000_000
    # And that flows into the budgets.
    assert mb.tool_output_char_budget("some-new-model", explicit_window=1_000_000) == 1_000_000
    # A non-positive/None explicit value is ignored (table still decides).
    assert mb.context_window("gpt-4o", explicit=0) == 128_000


def test_completion_budget_clamped_to_provider_max_output():
    from app.agent_runtime import model_budget as mb
    # gpt-4-turbo caps output at 4096 — must NOT be handed the 16384 floor (→ 400).
    assert mb.completion_token_budget("gpt-4-turbo") == 4_096
    # gemini-2 (1M window) caps at 8192, not the 32768 the window would imply.
    assert mb.completion_token_budget("gemini-2.0-flash") == 8_192
    # gpt-4.1 supports its full 32768.
    assert mb.completion_token_budget("gpt-4.1") == 32_768
    # Unknown model keeps the historical floor (no regression).
    assert mb.completion_token_budget("totally-unknown") == mb.COMPLETION_TOKENS_FLOOR


# ======================= B2: elastic replay caps ===========================


def test_elastic_replay_caps_floor_and_ceiling():
    from app.agent_runtime import session_agent as sa
    # Small/unknown model → exactly the historical floor.
    c, ch = sa._elastic_replay_caps("gpt-4o", None)
    assert c == sa._MAX_MESSAGES and ch == sa._MAX_REPLAY_MSG
    # Huge window → scaled but bounded by the ceilings.
    c2, ch2 = sa._elastic_replay_caps("gpt-4.1", None)  # 1M window
    assert c2 == sa._MAX_MESSAGES_CEIL and ch2 == sa._MAX_REPLAY_MSG_CEIL
    assert c2 > sa._MAX_MESSAGES and ch2 > sa._MAX_REPLAY_MSG
    # Explicit window override drives it too.
    c3, ch3 = sa._elastic_replay_caps("unknown", 1_000_000)
    assert c3 == sa._MAX_MESSAGES_CEIL


# ============================ CF: credential clarity =======================


def test_missing_vault_credential_raises_not_anonymous(client, monkeypatch):
    from app.security import keyring_store
    pid = _provider(client)  # stores access_key + secret_key refs
    # Simulate an out-of-sync vault: the secret_key ref exists on the row but its
    # value is gone from the vault.
    keyring_store.delete_secret("cloud_provider", f"{pid}/secret_key")
    conn = _conn()
    try:
        with pytest.raises(client_factory.CredentialResolutionError):
            client_factory.build_s3_client(conn, pid)
    finally:
        conn.close()


def test_no_credentials_still_anonymous(client, monkeypatch):
    from botocore import UNSIGNED
    # A provider with NO key refs at all → legit anonymous, not an error.
    pid = client.post("/cloud-providers", json={
        "name": "anon", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1"}).json()["id"]
    conn = _conn()
    try:
        c = client_factory.build_s3_client(conn, pid)
        assert c.meta.config.signature_version is UNSIGNED
    finally:
        conn.close()


# ============================ CSV: delimiter order =========================


def test_tsv_with_comma_in_header_cell_parses_via_tab(tmp_path):
    from app.analysis import access_logs
    # A tab-delimited log whose FIRST header cell contains a comma. The v0.27.0
    # early-break used to lock onto comma → all request fields null. Now tab wins.
    src = tmp_path / "log.tsv"
    src.write_text("ts,extra\tmethod\tpath\tstatus\tbytes\n"
                   "2026-07-15T10:00:00Z,x\tGET\t/a\t200\t10\n")
    rows = access_logs._parse_csv(src)
    assert len(rows) == 1
    assert rows[0]["method"] == "GET"
    assert rows[0]["status_code"] == 200
    assert rows[0]["path"] == "/a"
