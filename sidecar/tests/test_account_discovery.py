"""Tests for Phase 14 account discovery (deterministic, read-only).

A fake S3 client stands in for boto3 (no live cloud, no credentials). These
verify: list_buckets statuses + no secret leak, the account_discovery run flow,
max_buckets bounding, per-bucket error isolation, config-snapshot status mapping,
inventory/logging evidence-source discovery, that NO object scan or body download
happens, that reports carry no secrets, and that Agent mode is rejected cleanly.
"""

import datetime as _dt
import json
import sqlite3

import pytest
from botocore.exceptions import ClientError

from app import config, run_service
from app.s3 import account_tools, client_factory
from app.s3 import tools as s3tools

ACCESS = "AKIAIOSFODNN7EXAMPLE"


def _cerr(code: str, http: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "msg"}, "ResponseMetadata": {"HTTPStatusCode": http}},
        "Op",
    )


class FakeS3:
    """Configurable read-only fake. Object-level APIs hard-fail if ever called."""

    def __init__(self, buckets=("b-one", "b-two"), *, list_error=None, overrides=None, per_bucket=None):
        self._buckets = list(buckets)
        self._list_error = list_error
        self._ov = overrides or {}
        self._per_bucket = per_bucket or {}

    def _raise_if(self, method, Bucket=None):
        err = self._per_bucket.get(Bucket, {}).get(method, self._ov.get(method))
        if err is not None:
            raise err

    # account / existence
    def list_buckets(self):
        if self._list_error is not None:
            raise self._list_error
        return {"Buckets": [{"Name": n, "CreationDate": _dt.datetime(2026, 1, 1)} for n in self._buckets],
                "Owner": {"DisplayName": "acct"}}

    def head_bucket(self, Bucket=None):
        self._raise_if("head_bucket", Bucket)
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    # read-only config
    def get_bucket_location(self, Bucket=None):
        self._raise_if("get_bucket_location", Bucket)
        return {"LocationConstraint": "us-west-2"}

    def get_bucket_versioning(self, Bucket=None):
        self._raise_if("get_bucket_versioning", Bucket)
        return {"Status": "Enabled"}

    def get_bucket_encryption(self, Bucket=None):
        self._raise_if("get_bucket_encryption", Bucket)
        return {"ServerSideEncryptionConfiguration": {"Rules": [
            {"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}}

    def get_bucket_lifecycle_configuration(self, Bucket=None):
        self._raise_if("get_bucket_lifecycle_configuration", Bucket)
        return {"Rules": [{"ID": "r", "Status": "Enabled", "Expiration": {"Days": 30}}]}

    def get_bucket_logging(self, Bucket=None):
        self._raise_if("get_bucket_logging", Bucket)
        return {"LoggingEnabled": {"TargetBucket": "log-bucket", "TargetPrefix": "access/"}}

    def get_bucket_replication(self, Bucket=None):
        self._raise_if("get_bucket_replication", Bucket)
        return {"ReplicationConfiguration": {"Rules": [{"Status": "Enabled"}]}}

    def get_bucket_policy(self, Bucket=None):
        self._raise_if("get_bucket_policy", Bucket)
        return {"Policy": "{}"}

    def get_public_access_block(self, Bucket=None):
        self._raise_if("get_public_access_block", Bucket)
        return {"PublicAccessBlockConfiguration": {
            "BlockPublicAcls": True, "IgnorePublicAcls": True,
            "BlockPublicPolicy": True, "RestrictPublicBuckets": True}}

    def get_bucket_tagging(self, Bucket=None):
        self._raise_if("get_bucket_tagging", Bucket)
        return {"TagSet": [{"Key": "team", "Value": "data"}]}

    def list_bucket_inventory_configurations(self, Bucket=None):
        self._raise_if("list_bucket_inventory_configurations", Bucket)
        return {"InventoryConfigurationList": [{
            "Id": "inv1", "IsEnabled": True,
            "Destination": {"S3BucketDestination": {
                "Bucket": "arn:aws:s3:::inv-dest", "Prefix": "inv/", "Format": "CSV"}},
            "Schedule": {"Frequency": "Daily"}, "IncludedObjectVersions": "Current"}]}

    # object-level APIs must never be used by account discovery
    def list_objects_v2(self, **kwargs):
        raise AssertionError("account_discovery must not scan objects")

    def get_object(self, **kwargs):
        raise AssertionError("account_discovery must not download object bodies")


@pytest.fixture()
def sync_runs(monkeypatch):
    monkeypatch.setattr(run_service, "start", run_service.run_sync)


def _provider(client):
    return client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": ACCESS, "secret_key": "shh",
    }).json()["id"]


def _use_fake(monkeypatch, fake):
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)


def _run_discovery(client, provider_id, **body):
    created = client.post("/runs", json={
        "run_type": "account_discovery", "provider_id": provider_id,
        "user_prompt": "discover", "title": "acct", **body,
    }).json()
    rid = created["run_id"]
    assert client.post(f"/runs/{rid}/message", json={"content": "go"}).status_code == 200
    return rid


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


# --- list_buckets tool ------------------------------------------------------


def test_list_buckets_success(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(buckets=["a", "b", "c"]))
    out = s3tools.list_buckets(_db(), pid)
    assert out["success"] and out["status"] == "available"
    assert out["bucket_count"] == 3
    assert {b["name"] for b in out["buckets"]} == {"a", "b", "c"}


def test_list_buckets_access_denied(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(list_error=_cerr("AccessDenied", 403)))
    out = s3tools.list_buckets(_db(), pid)
    assert out["status"] == "access_denied" and out["success"] is False


def test_list_buckets_provider_unsupported(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(list_error=_cerr("NotImplemented", 501)))
    out = s3tools.list_buckets(_db(), pid)
    assert out["status"] == "provider_unsupported"


def test_list_buckets_does_not_leak_secret(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(buckets=["a"]))
    out = s3tools.list_buckets(_db(), pid)
    assert ACCESS not in json.dumps(out)


# --- account_discovery run flow ---------------------------------------------


def test_account_discovery_empty_account(client, monkeypatch, sync_runs):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(buckets=[]))
    rid = _run_discovery(client, pid)
    detail = client.get(f"/runs/{rid}").json()
    assert detail["status"] == "completed"
    profile = client.get(f"/runs/{rid}/account-profile").json()
    assert profile["visible_count"] == 0 and profile["buckets"] == []


def test_account_discovery_enumerates_and_snapshots(client, monkeypatch, sync_runs):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(buckets=["b-one", "b-two"]))
    rid = _run_discovery(client, pid)
    detail = client.get(f"/runs/{rid}").json()
    assert detail["status"] == "completed"
    names = {t["tool_name"] for t in detail["tool_calls"]}
    assert {"test_credentials", "list_buckets", "get_bucket_config_snapshot",
            "discover_evidence_sources", "generate_markdown_report"} <= names
    assert "list_objects_v2" not in names  # no object scan

    profile = client.get(f"/runs/{rid}/account-profile").json()
    assert profile["visible_count"] == 2 and profile["processed_count"] == 2
    one = next(b for b in profile["buckets"] if b["bucket_name"] == "b-one")
    assert one["encryption_status"] == "available"
    assert one["region"] == "us-west-2"
    assert any(s["source_type"] == "inventory" and s["status"] == "available"
               for s in one["evidence_sources"])


def test_account_discovery_respects_max_buckets(client, monkeypatch, sync_runs):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(buckets=[f"b{i}" for i in range(5)]))
    rid = _run_discovery(client, pid, max_buckets=2)
    profile = client.get(f"/runs/{rid}/account-profile").json()
    assert profile["truncated"] is True
    assert profile["processed_count"] == 2
    assert profile["visible_count"] == 5


def test_account_discovery_include_exclude_patterns(client, monkeypatch, sync_runs):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(buckets=["logs-a", "logs-b", "data-c"]))
    rid = _run_discovery(client, pid, include_pattern="logs-*", exclude_pattern="*-b")
    profile = client.get(f"/runs/{rid}/account-profile").json()
    assert {b["bucket_name"] for b in profile["buckets"]} == {"logs-a"}


def test_account_discovery_continues_on_per_bucket_denial(client, monkeypatch, sync_runs):
    pid = _provider(client)
    denied = {m: _cerr("AccessDenied", 403) for m in (
        "head_bucket", "get_bucket_location", "get_bucket_encryption", "get_bucket_logging",
        "get_bucket_lifecycle_configuration", "list_bucket_inventory_configurations")}
    fake = FakeS3(buckets=["good", "denied"], per_bucket={"denied": denied})
    _use_fake(monkeypatch, fake)
    rid = _run_discovery(client, pid)
    detail = client.get(f"/runs/{rid}").json()
    assert detail["status"] == "completed"  # the whole run did NOT fail
    profile = client.get(f"/runs/{rid}/account-profile").json()
    good = next(b for b in profile["buckets"] if b["bucket_name"] == "good")
    denied_b = next(b for b in profile["buckets"] if b["bucket_name"] == "denied")
    assert good["encryption_status"] == "available"
    assert "encryption" in denied_b["access_denied_items"]


# --- bucket config snapshot status mapping ----------------------------------


def test_config_snapshot_statuses_mapped(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3())
    snap = account_tools.get_bucket_config_snapshot(_db(), pid, "b")
    assert snap["encryption_status"] == "available"
    assert snap["versioning_status"] == "available" and snap["versioning_enabled"] is True
    assert snap["logging_status"] == "available" and snap["logging_enabled"] is True
    assert snap["inventory_status"] == "available"
    assert snap["public_access_block_status"] == "available"


def test_config_snapshot_not_configured_unsupported_denied(client, monkeypatch):
    pid = _provider(client)
    fake = FakeS3(overrides={
        "get_bucket_encryption": _cerr("ServerSideEncryptionConfigurationNotFoundError", 404),
        "get_bucket_lifecycle_configuration": _cerr("NotImplemented", 501),
        "get_bucket_logging": _cerr("AccessDenied", 403),
    })
    _use_fake(monkeypatch, fake)
    snap = account_tools.get_bucket_config_snapshot(_db(), pid, "b")
    assert snap["encryption_status"] == "not_configured"
    assert snap["lifecycle_status"] == "provider_unsupported"
    assert snap["logging_status"] == "access_denied"
    assert "lifecycle" in snap["provider_unsupported_items"]
    assert "logging" in snap["access_denied_items"]


# --- evidence source discovery ----------------------------------------------


def test_inventory_discovery_available(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3())
    ev = account_tools.discover_evidence_sources(_db(), pid, "b")
    inv = next(s for s in ev["sources"] if s["source_type"] == "inventory")
    assert inv["status"] == "available" and inv["configured"] is True
    assert inv["configurations"][0]["destination_bucket"] == "inv-dest"  # ARN reduced to name
    assert inv["configurations"][0]["frequency"] == "Daily"


def test_inventory_discovery_not_configured(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(overrides={
        "list_bucket_inventory_configurations": _cerr("NoSuchConfiguration", 404)}))
    ev = account_tools.discover_evidence_sources(_db(), pid, "b")
    inv = next(s for s in ev["sources"] if s["source_type"] == "inventory")
    assert inv["status"] == "not_configured" and inv["configured"] is False


def test_inventory_discovery_provider_unsupported(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(overrides={
        "list_bucket_inventory_configurations": _cerr("NotImplemented", 501)}))
    ev = account_tools.discover_evidence_sources(_db(), pid, "b")
    inv = next(s for s in ev["sources"] if s["source_type"] == "inventory")
    assert inv["status"] == "provider_unsupported"


def test_logging_discovery_available(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3())
    ev = account_tools.discover_evidence_sources(_db(), pid, "b")
    log = next(s for s in ev["sources"] if s["source_type"] == "server_access_logging")
    assert log["status"] == "available" and log["target_bucket"] == "log-bucket"


def test_logging_discovery_not_configured(client, monkeypatch):
    pid = _provider(client)

    class NoLog(FakeS3):
        def get_bucket_logging(self, Bucket=None):
            return {}  # logging API present but nothing enabled

    _use_fake(monkeypatch, NoLog())
    ev = account_tools.discover_evidence_sources(_db(), pid, "b")
    log = next(s for s in ev["sources"] if s["source_type"] == "server_access_logging")
    assert log["status"] == "not_configured"


def test_logging_discovery_access_denied(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3(overrides={"get_bucket_logging": _cerr("AccessDenied", 403)}))
    ev = account_tools.discover_evidence_sources(_db(), pid, "b")
    log = next(s for s in ev["sources"] if s["source_type"] == "server_access_logging")
    assert log["status"] == "access_denied"


def test_future_evidence_sources_marked_not_implemented(client, monkeypatch):
    pid = _provider(client)
    _use_fake(monkeypatch, FakeS3())
    ev = account_tools.discover_evidence_sources(_db(), pid, "b")
    placeholders = {s["source_type"]: s["status"] for s in ev["sources"]
                    if s["source_type"] in ("cloudtrail", "storage_lens", "provider_access_log")}
    assert placeholders == {"cloudtrail": "not_implemented", "storage_lens": "not_implemented",
                            "provider_access_log": "not_implemented"}


# --- safety: no secret / no scan / no body download -------------------------


def test_report_has_no_secrets_or_signatures(client, monkeypatch, sync_runs):
    pid = _provider(client)

    class LeakyLog(FakeS3):
        def get_bucket_logging(self, Bucket=None):
            # secret-shaped target prefix must be redacted before storage/report
            return {"LoggingEnabled": {"TargetBucket": "log-bucket",
                                       "TargetPrefix": "logs/?X-Amz-Signature=LEAKSIG&token=abc"}}

    _use_fake(monkeypatch, LeakyLog(buckets=["b-one"]))
    rid = _run_discovery(client, pid)
    report = client.get(f"/reports/{rid}").json()["content"]
    assert ACCESS not in report
    assert "X-Amz-Signature=LEAKSIG" not in report
    assert "AKIA" not in report


def test_account_discovery_never_scans_or_downloads(client, monkeypatch, sync_runs):
    pid = _provider(client)
    # FakeS3.list_objects_v2 / get_object raise AssertionError if ever called.
    _use_fake(monkeypatch, FakeS3(buckets=["b-one", "b-two"]))
    rid = _run_discovery(client, pid)
    assert client.get(f"/runs/{rid}").json()["status"] == "completed"


# --- agent mode disabled cleanly --------------------------------------------


def test_account_discovery_creates_deterministic_run(client):
    """There is no LLM planner: account_discovery always runs as a deterministic
    run (a `planner_mode` field in the body is ignored — the concept is gone)."""
    pid = _provider(client)
    r = client.post("/runs", json={
        "run_type": "account_discovery", "provider_id": pid, "user_prompt": "go",
    })
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "pending"


def test_account_profile_404_when_absent(client):
    r = client.get("/runs/does-not-exist/account-profile")
    assert r.status_code == 404
