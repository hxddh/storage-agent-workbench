"""Tests for Phase 06 read-only bucket configuration review.

Uses a fake S3 client (a mock) so no live credentials are needed and the six
tools can each issue reads without Stubber's strict global ordering.
"""

import json
import sqlite3
from typing import Any

import pytest
from botocore.exceptions import ClientError

from app import config, run_service
from app.s3 import client_factory
from app.s3 import config_tools as ct

# A policy that is deliberately insecure; includes an account-id-like number we
# assert never reaches the report.
INSECURE_POLICY = json.dumps({
    "Version": "2012-10-17",
    "Statement": [{
        "Sid": "PublicRead",
        "Effect": "Allow",
        "Principal": "*",
        "Action": ["s3:GetObject", "s3:ListBucket"],
        "Resource": "arn:aws:s3:::demo-bucket/*",
        "Condition": {"StringEquals": {"aws:SourceAccount": "123456789012"}},
    }],
})

ALL_USERS = "http://acs.amazonaws.com/groups/global/AllUsers"


def _err(code: str, http: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": code}, "ResponseMetadata": {"HTTPStatusCode": http}},
        "Get",
    )


def _default_behaviors() -> dict[str, Any]:
    return {
        "get_bucket_location": {"LocationConstraint": "us-east-1"},
        "get_bucket_versioning": {"Status": "Enabled"},
        "get_bucket_lifecycle_configuration": _err("NoSuchLifecycleConfiguration"),
        "get_bucket_encryption": _err("ServerSideEncryptionConfigurationNotFoundError"),
        "get_bucket_logging": {},  # no LoggingEnabled
        "get_bucket_policy": {"Policy": INSECURE_POLICY},
        "get_bucket_cors": {"CORSRules": [{"AllowedOrigins": ["*"]}]},
        "get_bucket_acl": {"Grants": [{"Grantee": {"URI": ALL_USERS}, "Permission": "READ"}]},
        "get_public_access_block": _err("NoSuchPublicAccessBlockConfiguration"),
        "get_bucket_replication": _err("ReplicationConfigurationNotFoundError"),
        "get_bucket_notification_configuration": {},
        "get_bucket_tagging": _err("NoSuchTagSet"),
        "list_objects_v2": {"Contents": [{"Key": "a.txt", "Size": 100}, {"Key": "b.txt", "Size": 200}],
                            "IsTruncated": False},
    }


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


@pytest.fixture()
def cfg(client, monkeypatch):
    pid = client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAEXAMPLE", "secret_key": "shhh",
        "mode": "readonly",
    }).json()["id"]

    fake = FakeS3(_default_behaviors())
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    monkeypatch.setattr(run_service, "start", run_service.run_sync)
    return type("Cfg", (), {"client": client, "pid": pid, "fake": fake})


def _conn():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


# --- unit: individual tools -------------------------------------------------


def test_security_detects_public_principal_and_anonymous_get(cfg):
    conn = _conn()
    try:
        out = ct.review_bucket_security(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    cats = {f["category"] for f in out["findings"]}
    titles = " ".join(f["title"] for f in out["findings"])
    assert out["facts"]["public_principal"] is True
    assert out["facts"]["anonymous_get_object"] is True
    assert "Critical" in cats  # anonymous GetObject + public ACL
    assert "Anonymous s3:GetObject" in titles
    assert "CORS allows all origins" in titles


AUTH_USERS = "http://acs.amazonaws.com/groups/global/AuthenticatedUsers"


def test_acl_authenticated_users_grant_is_flagged_public(cfg):
    """AuthenticatedUsers (any AWS account) is effectively public — the review
    must flag it like AllUsers (previously silently passed)."""
    cfg.fake.behaviors["get_bucket_acl"] = {
        "Grants": [{"Grantee": {"URI": AUTH_USERS}, "Permission": "READ"}]}
    conn = _conn()
    try:
        out = ct.review_bucket_security(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    assert out["facts"]["acl_public"] is True
    assert any("ACL grants public access" in f["title"] for f in out["findings"])


def test_policy_partial_wildcard_principal_is_not_public(cfg):
    """A principal ARN merely CONTAINING '*' (role/deploy-*) must not be
    flagged anonymous — only an exact '*' principal is public."""
    cfg.fake.behaviors["get_bucket_policy"] = {"Policy": json.dumps({
        "Statement": [{"Effect": "Allow",
                       "Principal": {"AWS": "arn:aws:iam::123:role/deploy-*"},
                       "Action": "s3:GetObject"}]})}
    conn = _conn()
    try:
        out = ct.review_bucket_security(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    assert out["facts"]["public_principal"] is False
    assert out["facts"]["anonymous_get_object"] is False


def test_all_reads_erroring_is_inconclusive_not_reviewed(cfg):
    for _, method in ct._CONFIG_READS:
        cfg.fake.behaviors[method] = _err("InternalError", 500)
    conn = _conn()
    try:
        out = ct.get_bucket_config_summary(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    assert out["overall_status"] == "inconclusive"
    assert len(out["error_items"]) == len(out["config_items"])


def test_summary_exposes_bucket_region_and_mismatch(cfg):
    cfg.fake.behaviors["get_bucket_location"] = {"LocationConstraint": "eu-west-1"}
    conn = _conn()
    try:
        out = ct.get_bucket_config_summary(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    # Provider fixture is configured us-east-1; the bucket really lives in
    # eu-west-1 → the #1 SignatureDoesNotMatch cause is now visible.
    assert out["bucket_region"] == "eu-west-1"
    assert out["region_mismatch"] is True


def test_region_mismatch_not_flagged_for_auto_or_alias(cfg):
    # Legacy 'EU' LocationConstraint == eu-west-1 → not a mismatch when the
    # provider is configured eu-west-1.
    assert ct._region_mismatch("EU", "eu-west-1") is False
    assert ct._region_mismatch("us-east-1", "US") is False
    # R2-style 'auto' provider region is never a mismatch.
    assert ct._region_mismatch("us-east-1", "auto") is False
    assert ct._region_mismatch(None, "") is False
    # A genuine difference still flags.
    assert ct._region_mismatch("eu-west-1", "us-east-1") is True


def test_lifecycle_review_surfaces_mfa_delete(cfg):
    cfg.fake.behaviors["get_bucket_versioning"] = {"Status": "Enabled", "MFADelete": "Enabled"}
    conn = _conn()
    try:
        out = ct.review_bucket_lifecycle(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    assert out["facts"]["mfa_delete_enabled"] is True


def test_errored_config_read_surfaces_as_finding_not_silent(cfg):
    """A genuine read error (e.g. a transient 5xx) must NOT be silently dropped —
    otherwise the review implies the aspect is clean when it was never assessed."""
    cfg.fake.behaviors["get_bucket_policy"] = _err("InternalError", 500)
    conn = _conn()
    try:
        out = ct.review_bucket_security(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    titles = " ".join(f["title"] for f in out["findings"])
    cats = {f["category"] for f in out["findings"]}
    assert "Could not read bucket policy" in titles
    assert "Warning" in cats


def test_summary_reports_errored_read_in_findings_and_error_items(cfg):
    cfg.fake.behaviors["get_bucket_versioning"] = _err("InternalError", 500)
    conn = _conn()
    try:
        out = ct.get_bucket_config_summary(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    assert "versioning" in out["error_items"]
    assert any("Could not read versioning" in f["title"] for f in out["findings"])


def test_lifecycle_detects_missing_abort_and_noncurrent(cfg):
    conn = _conn()
    try:
        out = ct.review_bucket_lifecycle(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    titles = " ".join(f["title"] for f in out["findings"])
    # lifecycle is not configured -> opportunity; versioning enabled
    assert "No lifecycle configuration" in titles


def test_lifecycle_versioning_without_noncurrent(cfg):
    # lifecycle present but without noncurrent expiration, versioning enabled
    cfg.fake.behaviors["get_bucket_lifecycle_configuration"] = {
        "Rules": [{"AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}, "Expiration": {"Days": 30}}]
    }
    conn = _conn()
    try:
        out = ct.review_bucket_lifecycle(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    titles = " ".join(f["title"] for f in out["findings"])
    assert "Versioning enabled without noncurrent cleanup" in titles


def test_observability_detects_logging_not_configured(cfg):
    conn = _conn()
    try:
        out = ct.review_bucket_observability(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    titles = " ".join(f["title"] for f in out["findings"])
    assert "Server access logging not enabled" in titles


def test_cost_generates_lifecycle_opportunities(cfg):
    conn = _conn()
    try:
        out = ct.review_bucket_cost_optimization(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    cats = {f["category"] for f in out["findings"]}
    assert "Opportunity" in cats


def test_performance_profile_bounded_max_keys(cfg):
    conn = _conn()
    try:
        out = ct.review_bucket_performance_profile(conn, cfg.pid, "demo-bucket", None)
    finally:
        conn.close()
    assert out["facts"]["max_keys"] == ct.PERF_MAX_KEYS == 1000
    # confirm the actual call used a bounded MaxKeys (one page, no body reads)
    listing = [c for c in cfg.fake.calls if c[0] == "list_objects_v2"]
    assert listing and listing[-1][1]["MaxKeys"] <= 1000


def test_provider_unsupported_does_not_raise(cfg):
    cfg.fake.behaviors["get_bucket_policy"] = _err("NotImplemented", 501)
    conn = _conn()
    try:
        out = ct.review_bucket_security(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    cats = {f["category"] for f in out["findings"]}
    assert "Provider unsupported" in cats


def test_access_denied_does_not_raise(cfg):
    cfg.fake.behaviors["get_bucket_policy"] = _err("AccessDenied", 403)
    conn = _conn()
    try:
        out = ct.review_bucket_security(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    # access denied surfaces as a warning finding, not an exception
    assert any("Access denied" in f["title"] for f in out["findings"])


def test_config_summary_status_buckets(cfg):
    conn = _conn()
    try:
        out = ct.get_bucket_config_summary(conn, cfg.pid, "demo-bucket")
    finally:
        conn.close()
    assert out["config_items"]["policy"] == "available"
    assert out["config_items"]["lifecycle"] == "not_configured"
    assert out["overall_status"] in ("reviewed", "partial_access", "provider_limited")


# --- full run flow ----------------------------------------------------------


def _start_review(cfg):
    created = cfg.client.post("/runs", json={
        "run_type": "bucket_config_review", "provider_id": cfg.pid,
        "bucket": "demo-bucket", "user_prompt": "review config",
    }).json()
    run_id = created["run_id"]
    assert cfg.client.post(f"/runs/{run_id}/message", json={"content": "go"}).status_code == 200
    return run_id


def test_config_review_run_invokes_all_six_tools(cfg):
    run_id = _start_review(cfg)
    detail = cfg.client.get(f"/runs/{run_id}").json()
    assert detail["status"] == "completed"
    names = {t["tool_name"] for t in detail["tool_calls"]}
    assert {"get_bucket_config_summary", "review_bucket_security", "review_bucket_lifecycle",
            "review_bucket_observability", "review_bucket_cost_optimization",
            "review_bucket_performance_profile"} <= names


def test_config_review_tool_calls_and_audit_have_run_id(cfg):
    run_id = _start_review(cfg)
    conn = _conn()
    try:
        tc = conn.execute("SELECT count(*) FROM tool_calls WHERE run_id=?", (run_id,)).fetchone()[0]
        al = conn.execute("SELECT count(*) FROM audit_logs WHERE run_id=? AND event_type LIKE 'tool.%'", (run_id,)).fetchone()[0]
    finally:
        conn.close()
    assert tc >= 6 and al >= 6


def test_config_review_report_sanitized_no_raw_policy(cfg):
    run_id = _start_review(cfg)
    report = cfg.client.get(f"/reports/{run_id}").json()["content"]
    assert "# Bucket Configuration Review Report" in report
    assert "## Security Review" in report and "## Provider Unsupported Items" in report
    # no secrets / account id / raw policy
    assert "AKIAEXAMPLE" not in report
    assert "123456789012" not in report           # account id from policy condition
    assert "arn:aws:s3:::demo-bucket" not in report  # raw policy resource not dumped
    assert '"Statement"' not in report               # raw policy doc not dumped


def test_config_review_sse_events(cfg):
    run_id = _start_review(cfg)
    text = cfg.client.get(f"/runs/{run_id}/events").text
    types = [json.loads(l[5:].strip())["type"] for l in text.splitlines() if l.startswith("data:")]
    for required in ("tool_call_started", "tool_call_finished", "finding", "report_ready"):
        assert required in types
    assert "plan" not in types  # no canned plan — the real tool trace stands in for it


def test_config_review_single_api_failure_does_not_fail_run(cfg):
    # An unexpected error on one read must not fail the whole run.
    cfg.fake.behaviors["get_bucket_cors"] = _err("InternalError", 500)
    run_id = _start_review(cfg)
    detail = cfg.client.get(f"/runs/{run_id}").json()
    assert detail["status"] == "completed"
