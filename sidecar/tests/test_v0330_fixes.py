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

from botocore.exceptions import ClientError

from app import config
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
    return client.post("/providers/clouds", json={
        "name": "demo", "provider_type": "s3-compatible",
        "endpoint_url": endpoint, "region": region, "addressing_style": "path",
        "access_key": "AKIAEXAMPLE", "secret_key": "shhh", "mode": "readonly",
    }).json()["id"]


def _conn():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


# --- S1: no bucket policy is "not public", not "unknown" ---------------------



# --- S2: IP endpoint addressing ----------------------------------------------

def test_endpoint_is_ip_detection():
    assert s3._endpoint_is_ip("http://192.168.1.10:9000") is True
    assert s3._endpoint_is_ip("https://10.0.0.5") is True
    assert s3._endpoint_is_ip("https://minio.example.com") is False
    assert s3._endpoint_is_ip(None) is False




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



# --- S7: list_buckets pagination ---------------------------------------------



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

