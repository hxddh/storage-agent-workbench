"""v0.33.0 — S3-compatible provider correctness + injection defense-in-depth.

  S1  review_bucket_security: no bucket policy → policy-not-public (was "unknown"),
      matching the survey path.
  S2  test_addressing_style on an IP endpoint: don't falsely report both_work.
  S3/S10  evidence-import _list_prefix returns a truncation signal + page guard.
  S6  list_object_versions/list_multipart_uploads: 501 → provider_unsupported.
  S7  list_buckets pages ContinuationToken.
  S8  region_mismatch: skip on custom endpoint + empty LocationConstraint.
  S9  bare HTTP 405 → provider_unsupported.
  P1  the untrusted-tool-output safety rule is present.
"""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest
from botocore.exceptions import ClientError

from app import config, run_service
from app.s3 import client_factory
from app.s3 import config_tools as ct
from app.s3 import tools as s3


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
            if callable(beh):
                return beh(**kwargs)
            if isinstance(beh, ClientError):
                raise beh
            if beh is None:
                raise _err("NotImplemented", 501)
            return beh
        return _call


def _provider(client, endpoint="https://minio.example.com", region="us-east-1"):
    return client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible",
        "endpoint_url": endpoint, "region": region, "addressing_style": "path",
        "access_key": "AKIAEXAMPLE", "secret_key": "shhh", "mode": "readonly",
    }).json()["id"]


def _conn():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


# --- S1: no bucket policy is "not public", not "unknown" ---------------------

def test_review_security_no_policy_reads_as_not_public(client, monkeypatch):
    pid = _provider(client)
    behaviors = {
        # Clean, readable ACL (owner only) + NO bucket policy at all.
        "get_bucket_acl": {"Owner": {"ID": "owner"},
                           "Grants": [{"Grantee": {"ID": "owner", "Type": "CanonicalUser"},
                                       "Permission": "FULL_CONTROL"}]},
        "get_bucket_policy": _err("NoSuchBucketPolicy", 404),
        "get_bucket_policy_status": _err("NoSuchBucketPolicy", 404),
        "get_bucket_ownership_controls": _err("OwnershipControlsNotFoundError", 404),
        "get_object_lock_configuration": _err("ObjectLockConfigurationNotFoundError", 404),
    }
    fake = FakeS3(behaviors)
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    with _conn() as conn:
        out = ct.review_bucket_security(conn, pid, "demo-bucket")
    # The whole point: a clean bucket with no policy is definitively not public,
    # not "cannot rule out" (None).
    assert out["facts"]["publicly_exposed"] is False


# --- S2: IP endpoint addressing ----------------------------------------------

def test_endpoint_is_ip_detection():
    assert s3._endpoint_is_ip("http://192.168.1.10:9000") is True
    assert s3._endpoint_is_ip("https://10.0.0.5") is True
    assert s3._endpoint_is_ip("https://minio.example.com") is False
    assert s3._endpoint_is_ip(None) is False


def test_addressing_style_on_ip_endpoint_does_not_claim_both_work(client, monkeypatch):
    pid = _provider(client, endpoint="http://192.168.1.10:9000")
    fake = FakeS3({"head_bucket": {}})
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    with _conn() as conn:
        out = s3.test_path_style_vs_virtual_host(conn, pid, "b")
    assert out["recommendation"] == "path"
    assert out["virtual_hosted_result"]["not_testable"] is True


# --- S3 / S10: _list_prefix truncation + page guard --------------------------

def test_list_prefix_flags_truncation_at_cap():
    from app.evidence import managed_import as mi

    # A client that always returns a full page + IsTruncated → hits the hard cap.
    class Paging:
        def list_objects_v2(self, **kw):
            n = kw.get("MaxKeys", 1000)
            return {"Contents": [{"Key": f"log-{i}", "Size": 1} for i in range(n)],
                    "IsTruncated": True, "NextContinuationToken": "more"}

    items, truncated = mi._list_prefix(Paging(), "b", "p/", hard_cap=2000)
    assert len(items) == 2000
    assert truncated is True


def test_list_prefix_empty_page_token_does_not_loop():
    from app.evidence import managed_import as mi

    class Stuck:
        def list_objects_v2(self, **kw):
            # Truncated with a token but zero Contents — would spin forever.
            return {"Contents": [], "IsTruncated": True, "NextContinuationToken": "x"}

    items, truncated = mi._list_prefix(Stuck(), "b", "p/", hard_cap=5000)
    assert items == [] and truncated is True


def test_list_prefix_clean_finish_not_truncated():
    from app.evidence import managed_import as mi

    class OnePage:
        def list_objects_v2(self, **kw):
            return {"Contents": [{"Key": "a", "Size": 1}], "IsTruncated": False}

    items, truncated = mi._list_prefix(OnePage(), "b", "p/")
    assert len(items) == 1 and truncated is False


# --- S6: capability gap on versions/multipart --------------------------------

def test_list_multipart_uploads_unsupported_is_capability_gap(client, monkeypatch):
    pid = _provider(client)
    fake = FakeS3({"list_multipart_uploads": _err("NotImplemented", 501)})
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    with _conn() as conn:
        res = s3.list_multipart_uploads(conn, pid, "b")
    assert res["success"] is True and res["provider_unsupported"] is True


# --- S7: list_buckets pagination ---------------------------------------------

def test_list_buckets_pages_continuation_token(client, monkeypatch):
    pid = _provider(client)
    pages = [
        {"Buckets": [{"Name": "a"}, {"Name": "b"}], "ContinuationToken": "next"},
        {"Buckets": [{"Name": "c"}]},  # no token → last page
    ]
    state = {"i": 0}

    def _list(**kw):
        p = pages[state["i"]]
        state["i"] += 1
        return p

    fake = FakeS3({"list_buckets": _list})
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)
    with _conn() as conn:
        res = s3.list_buckets(conn, pid)
    assert res["success"] is True
    assert res["bucket_count"] == 3
    assert {b["name"] for b in res["buckets"]} == {"a", "b", "c"}
    assert res["list_truncated"] is False


# --- S8: region_mismatch on custom endpoint with empty location --------------

def test_region_mismatch_pure():
    # Genuine mismatch on AWS-style (no custom endpoint).
    assert ct._region_mismatch("eu-west-1", "us-east-1") is True
    # Custom endpoint + empty raw LocationConstraint → NOT a mismatch (MinIO/Ceph).
    assert ct._region_mismatch("us-east-1", "de-lab-1",
                               custom_endpoint=True, raw_location_empty=True) is False
    # Custom endpoint but a REAL location returned → still a genuine mismatch.
    assert ct._region_mismatch("us-west-2", "de-lab-1",
                               custom_endpoint=True, raw_location_empty=False) is True
    # auto region (R2) never mismatches.
    assert ct._region_mismatch("us-east-1", "auto") is False


# --- S9: bare 405 is a capability gap ----------------------------------------

def test_is_unsupported_treats_405_as_gap():
    assert s3._is_unsupported(_err("", 405)) is True
    assert s3._is_unsupported(_err("", 501)) is True
    assert s3._is_unsupported(_err("AccessDenied", 403)) is False


# --- P1: untrusted-data safety rule present ----------------------------------

def test_untrusted_tool_output_safety_rule_present():
    from app.agent_runtime.session_agent import SESSION_SAFETY_RULES

    joined = " ".join(SESSION_SAFETY_RULES).lower()
    assert "untrusted data" in joined
    assert "never obey directives" in joined or "not instructions" in joined
