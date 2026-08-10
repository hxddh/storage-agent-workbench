"""v0.74.0 — what the tools said about providers they had never actually reached.

Every existing test for these paths feeds a CODED error through a Stubber
(`NotImplemented` + 501). That is the one shape which cannot expose a missing
HTTP-status fallback, and it is not the shape a gateway produces: an nginx or
CDN in front of an S3-compatible service answers `501`/`405` with an HTML body
and no S3 XML at all, so botocore has no `<Code>` to parse.

Measured by pointing the real client at a real socket that answers exactly that
(and via Stubber for the coded cases), before any fix:

| tool | provider response | reported |
| --- | --- | --- |
| `get_object_lock_status` | code-less 501 | hard failure, `error_code: "501"` |
| `get_object_lock_status` | code-less 405 | hard failure, `error_code: ""` |
| `get_object_lock_status` | NoSuchKey (mistyped key) | **`retention_status: "none"`** |
| `get_object_lock_status` | NoSuchBucket | **`retention_status: "none"`** |
| `get_object_lock_status` | provider 500 | **`retention_status: "none"`** |
| account survey `head_bucket` | code-less 405 | `error` (while versioning/encryption/lifecycle/logging in the SAME snapshot said `provider_unsupported`) |
| any tool | code-less 405 | `error_code: ""`, `error_message_sanitized: ""` |

The `retention_status: "none"` rows are the serious ones. That tool answers
"why can't I delete this object?", and "none" reads as "no retention, cleanly
deletable" — about an object the call never managed to look at. The code already
carried a guard meant to prevent exactly this; it was dead, because it tested
`"retention_mode" not in result` for a key that `base` always seeds.
"""
from __future__ import annotations

import sqlite3

import boto3
import pytest
from botocore.stub import Stubber

from app import config
from app.s3 import account_tools as at
from app.s3 import client_factory
from app.s3 import tools as s3

BUCKET = "bucket-alpha"


@pytest.fixture()
def cloud_id(client):
    return client.post("/cloud-providers", json={
        "name": "gateway-fronted", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "mode": "readonly",
    }).json()["id"]


@pytest.fixture()
def stub(monkeypatch):
    c = boto3.client("s3", region_name="us-east-1", aws_access_key_id="stub",
                     aws_secret_access_key="stub", endpoint_url="https://minio.example.com")
    s = Stubber(c)
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: c)
    s.activate()
    yield c, s
    s.deactivate()


def _db():
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def _lock(stub, code: str, http: int, key: str = "k"):
    _c, s = stub
    for op in ("get_object_retention", "get_object_legal_hold"):
        s.add_client_error(op, service_error_code=code, http_status_code=http)
    with _db() as conn:
        return s3.get_object_lock_status(conn, cloud_id_holder["id"], BUCKET, key)


cloud_id_holder: dict[str, str] = {}


@pytest.fixture(autouse=True)
def _hold(cloud_id):
    cloud_id_holder["id"] = cloud_id


# --- rule 18: a code-less capability gap is still a capability gap ----------


@pytest.mark.parametrize("http", [501, 405])
def test_object_lock_on_a_codeless_gap_is_provider_unsupported(stub, http):
    """A gateway with no Object-Lock API answers 501/405 with an HTML body, so
    there is no `NotImplemented` code to match. Rule 18: still a gap, never a
    hard failure."""
    res = _lock(stub, "", http)
    assert res["retention_status"] == s3.PROVIDER_UNSUPPORTED, res
    assert res["legal_hold_status"] == s3.PROVIDER_UNSUPPORTED, res
    assert res["success"] is True, res


def test_object_lock_still_reports_a_coded_gap(stub):
    """The coded path must keep working — this is what already had coverage."""
    res = _lock(stub, "NotImplemented", 501)
    assert res["retention_status"] == s3.PROVIDER_UNSUPPORTED
    assert res["legal_hold_status"] == s3.PROVIDER_UNSUPPORTED
    assert res["success"] is True


# --- the safety-relevant one: never claim an uninspected object is unlocked -


@pytest.mark.parametrize("code,http,label", [
    ("NoSuchKey", 404, "a mistyped key"),
    ("NoSuchBucket", 404, "the wrong bucket"),
    ("InternalError", 500, "a provider fault"),
    ("", 502, "a bare gateway error"),
])
def test_a_never_inspected_object_is_not_reported_as_unlocked(stub, code, http, label):
    """`retention_status: "none"` means "no retention is configured" — a claim
    about the object. After a hard error nothing was learned, so the honest
    answer is "unknown". Reporting "none" tells someone asking *why can't I
    delete this?* that it is cleanly deletable."""
    res = _lock(stub, code, http, key="typo-key")
    assert res["success"] is False, res
    assert res["retention_status"] == "unknown", f"{label}: {res}"
    assert res["legal_hold_status"] == "unknown", f"{label}: {res}"


def test_a_real_lock_is_still_reported_exactly(stub):
    """The guard must not swallow a determined answer."""
    from datetime import datetime, timezone

    _c, s = stub
    s.add_response("get_object_retention",
                   {"Retention": {"Mode": "COMPLIANCE",
                                  "RetainUntilDate": datetime(2030, 1, 1, tzinfo=timezone.utc)}},
                   expected_params={"Bucket": BUCKET, "Key": "locked"})
    s.add_response("get_object_legal_hold", {"LegalHold": {"Status": "ON"}},
                   expected_params={"Bucket": BUCKET, "Key": "locked"})
    with _db() as conn:
        res = s3.get_object_lock_status(conn, cloud_id_holder["id"], BUCKET, "locked")
    assert res["success"] is True
    assert res["retention_status"] == "active" and res["retention_mode"] == "COMPLIANCE"
    assert res["legal_hold_status"] == "on"


def test_no_lock_configured_is_still_a_clean_none(stub):
    """The genuine "this object has no lock" answer must survive — it is what
    distinguishes a determined `none` from an undetermined `unknown`."""
    res = _lock(stub, "NoSuchObjectLockConfiguration", 404)
    assert res["success"] is True
    assert res["retention_status"] == "none" and res["legal_hold_status"] == "none"


def test_access_denied_is_still_a_hard_error(stub):
    res = _lock(stub, "AccessDenied", 403)
    assert res["success"] is False and res["error_code"] == "AccessDenied"


# --- a failure that says nothing is not a failure report -------------------


def test_a_codeless_failure_still_names_its_cause(stub):
    """`error_code: "", error_message_sanitized: ""` is a failure the agent
    cannot explain and the user cannot act on. The HTTP status is the one thing
    we always have."""
    res = _lock(stub, "", 502, key="k")
    assert res["success"] is False
    assert "502" in (res.get("error_message_sanitized") or ""), res
    assert res.get("status_code") == 502, res


def test_the_error_code_itself_is_not_synthesized(stub):
    """Deliberate: `test_credentials` refuses to call a CODE-LESS 403 "valid
    credentials" precisely because the code is falsy. Filling `error_code` in
    from the HTTP status would silently invert that."""
    _c, s = stub
    s.add_client_error("list_buckets", service_error_code="", http_status_code=403)
    with _db() as conn:
        res = s3.test_credentials(conn, cloud_id_holder["id"])
    assert res["success"] is False, res
    assert res["identity_hint"] is None, res


# --- the survey must brand one gap one way ---------------------------------


def test_the_survey_treats_a_codeless_405_as_a_gap_like_everything_else(stub):
    """`head_bucket` checked `http == 501` while every other status in the same
    snapshot used the shared 501/405 rule, so one response produced two verdicts."""
    _c, s = stub
    s.add_client_error("head_bucket", service_error_code="", http_status_code=405)
    with _db() as conn:
        snap = at.get_bucket_config_snapshot(conn, cloud_id_holder["id"], BUCKET)
    from app.s3 import config_tools as ct
    assert snap["head_bucket_status"] == ct.PROVIDER_UNSUPPORTED, snap
