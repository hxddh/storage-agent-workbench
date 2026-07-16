"""Tests for the v0.30.0 correctness + truth batch.

F1 — publicly_exposed: a single TRUE signal (policy public with ACL unreadable,
     or ACL public with policy_status provider-unsupported) proves exposure.
F2 — truncated-PEM redaction no longer bypassed by a following foreign END armor.
F3 — 5xx code entries no longer duplicated by the generic ServerError entry.
F4 — survey diff: fields only the NEW survey has are baselined (not changes);
     a real became-public flip carries alert=true and sorts first.
F5 — user-chosen filenames are redacted at persist.
T2 — engine truth guards: unparsed log / unknown-size inventory lead with an
     honest warning instead of clean-looking metrics.
Survey — conditional ACL read (skipped under BucketOwnerEnforced), acl_public
     flag, evidence discovery reuses the snapshot's reads (GET dedupe), summary
     carries public counts + a critical finding.
C-1 — turn_guard.register_session_turn serializes turns per session.
C-2 — /runs/{id}/message claims the run atomically (second POST → 409).
"""
import json
import sqlite3
from typing import Any

import pytest
from botocore.exceptions import ClientError

from app import config
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
        self.calls: list[str] = []

    def __getattr__(self, method):
        def _call(**kwargs):
            self.calls.append(method)
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


def _provider(client):
    return client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAEXAMPLE", "secret_key": "shhh"}).json()["id"]


# ============================ F1: publicly_exposed ==========================


def test_policy_public_with_acl_unreadable_is_exposed(client, monkeypatch):
    pid = _provider(client)
    fake = FakeS3({
        "get_bucket_policy": {"Policy": "{}"},
        "get_bucket_cors": _err("NoSuchCORSConfiguration"),
        "get_bucket_encryption": {"ServerSideEncryptionConfiguration": {"Rules": [{}]}},
        "get_bucket_acl": _err("AccessDenied", 403),
        "get_public_access_block": _err("NoSuchPublicAccessBlockConfiguration"),
        "get_bucket_policy_status": {"PolicyStatus": {"IsPublic": True}},
        "get_bucket_ownership_controls": _err("OwnershipControlsNotFoundError"),
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _db()
    try:
        out = ct.review_bucket_security(conn, pid, "b")
        assert out["facts"]["publicly_exposed"] is True  # was None pre-fix
    finally:
        conn.close()


def test_acl_public_with_policy_status_unsupported_is_exposed(client, monkeypatch):
    """The common non-AWS case: GetBucketPolicyStatus unsupported, ACL public."""
    pid = _provider(client)
    fake = FakeS3({
        "get_bucket_policy": _err("NoSuchBucketPolicy"),
        "get_bucket_cors": _err("NoSuchCORSConfiguration"),
        "get_bucket_encryption": {"ServerSideEncryptionConfiguration": {"Rules": [{}]}},
        "get_bucket_acl": {"Grants": [{"Grantee": {"URI": ALL_USERS, "Type": "Group"},
                                       "Permission": "READ"}]},
        "get_public_access_block": _err("NoSuchPublicAccessBlockConfiguration"),
        "get_bucket_policy_status": _err("NotImplemented", 501),
        "get_bucket_ownership_controls": _err("NotImplemented", 501),
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _db()
    try:
        out = ct.review_bucket_security(conn, pid, "b")
        assert out["facts"]["acl_public"] is True
        assert out["facts"]["publicly_exposed"] is True  # was None pre-fix
    finally:
        conn.close()


# ============================ F2: PEM bypass ================================


def test_truncated_pem_followed_by_cert_is_redacted():
    from app.security.redaction import redact_text
    t = ("-----BEGIN RSA PRIVATE KEY-----\nMIIEowSECRETBODY\n"
         "-----BEGIN CERTIFICATE-----\ncertdata\n-----END CERTIFICATE-----")
    out = redact_text(t)
    assert "SECRETBODY" not in out          # the bypass shape is closed
    assert "certdata" in out                # the non-secret cert survives
    full = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- tail"
    o2 = redact_text(full)
    assert "abc" not in o2 and "tail" in o2  # full-block behavior unchanged


# ============================ F3: 5xx dedup =================================


def test_5xx_code_entry_not_duplicated_by_generic_entry():
    from app.error_triage import parser, playbooks
    p = parser.parse("HTTP/1.1 500 <Code>InternalError</Code>")
    m = playbooks.match(p)
    titles = [e["title"] for e in m]
    assert len([t for t in titles if "5xx" in t or "InternalError" in t]) == 1


# ============================ F4: diff baseline + alert =====================


def test_diff_baselines_new_fields_and_alerts_became_public():
    from app.repositories import account_discovery as repo
    old = {"buckets": [{"bucket_name": "a", "access_status": "available",
                        "encryption_status": "available"}]}          # pre-upgrade: no posture keys
    new = {"buckets": [{"bucket_name": "a", "access_status": "available",
                        "encryption_status": "available",
                        "policy_is_public": True, "policy_public_status": "available",
                        "object_ownership": None, "acls_disabled": None,
                        "acl_public": None, "publicly_exposed": True}]}
    d = repo.diff_profiles(old, new)
    # None of the new-only fields count as changes — they are baselined.
    assert d["change_count"] == 0
    assert "policy_is_public" in d.get("fields_baselined", [])

    # A REAL flip (both surveys carry the key) alerts and sorts first.
    old2 = {"buckets": [{"bucket_name": "a", "policy_is_public": False,
                         "region": "us-east-1"}]}
    new2 = {"buckets": [{"bucket_name": "a", "policy_is_public": True,
                         "region": "eu-west-1"}]}
    d2 = repo.diff_profiles(old2, new2)
    assert d2["changes"][0]["change"] == "policy_is_public"
    assert d2["changes"][0]["alert"] is True


# ============================ F5: filename redaction ========================


def test_uploaded_filename_is_redacted_at_persist(client):
    from app.repositories import session_datasets as sds
    ses = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    conn = _db()
    try:
        did = sds.upsert(conn, ses, "access_log",
                         "AKIAIOSFODNN7EXAMPLE-key.log", "x/y.log")
        conn.commit()
        row = sds.get(conn, did)
        assert "AKIAIOSFODNN7EXAMPLE" not in (row["source_filename"] or "")
    finally:
        conn.close()


# ============================ T2: truth guards ==============================


def test_unparsed_log_leads_with_honest_warning(tmp_path):
    from app.analysis import access_logs
    src = tmp_path / "app.log"
    src.write_text("random unstructured line without any request shape\n" * 20)
    ddb = tmp_path / "a.duckdb"
    access_logs.import_access_logs(src, ddb, "unknown")
    m = access_logs.analyze_access_logs(ddb)
    assert m["parsed_fraction"] == 0.0
    f = access_logs.derive_findings(m)
    assert [x["title"] for x in f] == ["Log mostly unparsed"]  # no fake hot-key/clean claims


def test_inventory_unknown_sizes_lead_with_warning(tmp_path):
    from app.analysis import inventory
    src = tmp_path / "inv.csv"
    # header with keys but no size column values
    src.write_text("bucket,key,size,last_modified,storage_class\n"
                   + "\n".join(f"b,k{i},,2026-01-01T00:00:00Z,STANDARD" for i in range(10)) + "\n")
    ddb = tmp_path / "i.duckdb"
    inventory.import_inventory_file(src, ddb)
    m = inventory.analyze_inventory(ddb)
    assert m["unknown_size_ratio"] > 0.5
    titles = [x["title"] for x in inventory.derive_findings(m)]
    assert "Inventory mostly missing sizes" in titles
    assert "No capacity concerns detected" not in titles


# ============================ Survey: ACL + dedupe + summary ================


def test_snapshot_skips_acl_under_bucket_owner_enforced(client, monkeypatch):
    from app.s3 import account_tools
    pid = _provider(client)
    fake = FakeS3({
        "get_bucket_location": {"LocationConstraint": "us-east-1"},
        "get_bucket_versioning": {"Status": "Enabled"},
        "get_bucket_encryption": {"ServerSideEncryptionConfiguration": {"Rules": [{}]}},
        "get_bucket_lifecycle_configuration": _err("NoSuchLifecycleConfiguration"),
        "get_bucket_logging": {},
        "get_bucket_replication": _err("ReplicationConfigurationNotFoundError"),
        "get_bucket_policy": _err("NoSuchBucketPolicy"),
        "get_public_access_block": _err("NoSuchPublicAccessBlockConfiguration"),
        "get_bucket_tagging": _err("NoSuchTagSet"),
        "list_bucket_inventory_configurations": {},
        "get_bucket_policy_status": _err("NoSuchBucketPolicy"),
        "get_bucket_ownership_controls": {
            "OwnershipControls": {"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]}},
        "get_bucket_acl": {"Grants": [{"Grantee": {"URI": ALL_USERS}, "Permission": "READ"}]},
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _db()
    try:
        snap = account_tools.get_bucket_config_snapshot(conn, pid, "b")
        assert snap["acl_status"] == "skipped_acls_disabled"
        assert snap["acl_public"] is False           # ACLs disabled → can't be ACL-public
        assert snap["publicly_exposed"] is False     # policy not-configured + ACLs off
        assert "get_bucket_acl" not in fake.calls    # the GET was actually skipped
        # Raw reads exposed for the survey's dedupe, marked private.
        assert "_raw_reads" in snap
    finally:
        conn.close()


def test_evidence_discovery_reuses_snapshot_reads(client, monkeypatch):
    from app.s3 import account_tools
    pid = _provider(client)
    fake = FakeS3({
        "get_bucket_logging": {"LoggingEnabled": {"TargetBucket": "logs", "TargetPrefix": "p/"}},
        "list_bucket_inventory_configurations": {},
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    conn = _db()
    try:
        pre = {
            "logging": {"status": "available",
                        "data": {"LoggingEnabled": {"TargetBucket": "logs", "TargetPrefix": "p/"}}},
            "inventory": {"status": "not_configured", "data": {}},
        }
        out = account_tools.discover_evidence_sources(conn, pid, "b", pre_reads=pre)
        assert out["success"] is True
        assert fake.calls == []  # zero S3 calls — both reads reused
        logging_src = next(s for s in out["sources"] if s["source_type"] == "server_access_logging")
        assert logging_src["configured"] is True and logging_src["target_bucket"] == "logs"
    finally:
        conn.close()


def test_survey_summary_counts_public_buckets():
    from app.runs.account_discovery_run import _build_summary
    buckets = [
        {"bucket_name": "open", "publicly_exposed": True, "policy_is_public": True,
         "evidence_sources": []},
        {"bucket_name": "closed", "publicly_exposed": False, "policy_is_public": False,
         "acls_disabled": True, "evidence_sources": []},
    ]
    s = _build_summary(buckets, 2, 2, False)
    assert s["public_bucket_count"] == 1
    assert s["public_buckets"] == ["open"]
    assert s["acls_disabled_count"] == 1
    assert "open" in s["buckets_needing_review"]


# ============================ C-1: session serialization ====================


def test_register_session_turn_returns_prior_live_handle():
    from app.agent_runtime import turn_guard
    turn_guard._reset_for_tests()
    h1, created1 = turn_guard.begin("t1", "sess")
    assert created1
    assert turn_guard.register_session_turn("sess", h1) is None  # first turn: no prior
    h2, _ = turn_guard.begin("t2", "sess")
    prior = turn_guard.register_session_turn("sess", h2)
    assert prior is h1  # live prior returned so the caller can cancel + wait
    # Once the prior resolves, a third turn sees no live prior.
    turn_guard.set_result("t2", {}, "sess")
    h3, _ = turn_guard.begin("t3", "sess")
    assert turn_guard.register_session_turn("sess", h3) is None
    turn_guard._reset_for_tests()


# ============================ C-2: runs message atomic claim ================


def test_runs_message_claims_atomically(client, monkeypatch):
    from app import run_service
    monkeypatch.setattr(run_service, "start", lambda run_id: None)  # don't execute
    pid = _provider(client)
    run_id = client.post("/runs", json={
        "run_type": "diagnostic", "provider_id": pid, "bucket": "b",
        "user_prompt": "x"}).json()["run_id"]
    r1 = client.post(f"/runs/{run_id}/message", json={"content": "go"})
    assert r1.status_code == 200
    # The first POST claimed the row (status=running even though nothing executed) —
    # a duplicate POST must be rejected instead of spawning a second executor.
    r2 = client.post(f"/runs/{run_id}/message", json={"content": "go again"})
    assert r2.status_code == 409
