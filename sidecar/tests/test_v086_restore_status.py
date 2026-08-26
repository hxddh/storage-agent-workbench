"""Restore state comes back with the listing, and silence is not "not archived".

"Why can't I read these objects?" is often answered by GLACIER plus whether a
restore is running. That state was only reachable one HeadObject at a time —
the exact N-follow-up-calls problem the `objects` block already exists to avoid
for size and storage class.

ListObjectsV2 carries it: `OptionalObjectAttributes=["RestoreStatus"]`. Sent
unconditionally, because it travels as the `x-amz-optional-object-attributes`
HEADER rather than a query parameter, so an S3-compatible gateway that does not
implement it ignores it — and most do not, which is exactly why the absent case
has to be a distinct answer instead of a comfortable zero.
"""
from __future__ import annotations

import datetime as dt
import sqlite3

import boto3
import pytest
from botocore.stub import Stubber

from app import config
from app.s3 import client_factory
from app.s3 import tools as s3

BUCKET = "restore-bucket"


@pytest.fixture()
def stub(monkeypatch):
    c = boto3.client("s3", region_name="us-east-1", aws_access_key_id="stub",
                     aws_secret_access_key="stub", endpoint_url="https://gw.example.com")
    s = Stubber(c)
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: c)
    s.activate()
    yield c, s
    s.deactivate()


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture()
def provider(client) -> str:
    return client.post("/cloud-providers", json={
        "name": "restore", "provider_type": "s3-compatible",
        "endpoint_url": "https://gw.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "mode": "readonly",
    }).json()["id"]


_EXPECTED = {"Bucket": BUCKET, "Prefix": "", "MaxKeys": 1000,
             "OptionalObjectAttributes": ["RestoreStatus"]}


def test_the_listing_asks_for_restore_status(stub, provider):
    """If the request stops carrying it, everything below is silently useless."""
    _c, s = stub
    s.add_response("list_objects_v2",
                   {"Contents": [], "KeyCount": 0, "IsTruncated": False},
                   expected_params=_EXPECTED)
    conn = _db()
    try:
        assert s3.list_objects_v2(conn, provider, BUCKET, 1000, delimiter=None)["success"]
        s.assert_no_pending_responses()
    finally:
        conn.close()


def test_restore_state_is_reported_per_key_and_rolled_up(stub, provider):
    _c, s = stub
    expiry = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc)
    s.add_response("list_objects_v2", {
        "Contents": [
            {"Key": "a", "Size": 1, "StorageClass": "GLACIER",
             "RestoreStatus": {"IsRestoreInProgress": True}},
            {"Key": "b", "Size": 2, "StorageClass": "GLACIER",
             "RestoreStatus": {"IsRestoreInProgress": False, "RestoreExpiryDate": expiry}},
            {"Key": "c", "Size": 3, "StorageClass": "STANDARD"},
        ],
        "KeyCount": 3, "IsTruncated": False,
    }, expected_params=_EXPECTED)
    conn = _db()
    try:
        out = s3.list_objects_v2(conn, provider, BUCKET, 1000, delimiter=None)
        by_key = {o["key"]: o for o in out["objects"]}
        assert by_key["a"]["restore_status"] == {"restore_in_progress": True,
                                                 "restore_expiry": None}
        assert by_key["b"]["restore_status"] == {"restore_in_progress": False,
                                                 "restore_expiry": expiry.isoformat()}
        # A STANDARD object simply has no restore state — absent, not False.
        assert by_key["c"]["restore_status"] is None
        assert out["restore_status_reported"] is True
        assert out["restore_in_progress_count"] == 1
    finally:
        conn.close()


def test_an_endpoint_that_says_nothing_is_unknown_not_zero(stub, provider):
    """The tri-state guard, and the case most providers land in.

    Every key GLACIER, none carrying RestoreStatus. `restore_in_progress_count`
    is 0 here only because there is nothing to count — so it must be paired with
    `restore_status_reported: False`, or a reader concludes "no restores are
    running" from an endpoint that was never asked the question.
    """
    _c, s = stub
    s.add_response("list_objects_v2", {
        "Contents": [{"Key": "a", "Size": 1, "StorageClass": "GLACIER"},
                     {"Key": "b", "Size": 2, "StorageClass": "DEEP_ARCHIVE"}],
        "KeyCount": 2, "IsTruncated": False,
    }, expected_params=_EXPECTED)
    conn = _db()
    try:
        out = s3.list_objects_v2(conn, provider, BUCKET, 1000, delimiter=None)
        assert out["restore_status_reported"] is False, out
        assert all(o["restore_status"] is None for o in out["objects"])
    finally:
        conn.close()


def test_the_rollup_counts_the_whole_page_not_just_the_detail_window(stub, provider):
    """`objects` is capped at OBJECT_DETAIL_LIMIT; the count must not be."""
    n = s3.OBJECT_DETAIL_LIMIT + 25
    _c, stubber = stub
    stubber.add_response("list_objects_v2", {
        "Contents": [{"Key": f"k{i}", "Size": 1, "StorageClass": "GLACIER",
                      "RestoreStatus": {"IsRestoreInProgress": True}} for i in range(n)],
        "KeyCount": n, "IsTruncated": False,
    }, expected_params=_EXPECTED)
    conn = _db()
    try:
        out = s3.list_objects_v2(conn, provider, BUCKET, 1000, delimiter=None)
        assert len(out["objects"]) == s3.OBJECT_DETAIL_LIMIT
        assert out["restore_in_progress_count"] == n, out["restore_in_progress_count"]
    finally:
        conn.close()


# --- the ask must never cost us the listing ----------------------------------


def test_a_directory_bucket_still_gets_its_objects(stub, provider):
    """Raised in review, and it is the P1 of the two.

    AWS does not accept `OptionalObjectAttributes` for S3 Express DIRECTORY
    buckets — the service model says so in its own note on the field — and a
    strict S3-compatible gateway may reject an unknown header outright. Sending
    it unconditionally would then break `list_objects_v2` itself, which is the
    core diagnostic, to add an optional field.

    So a rejection drops the ask and repeats the call. The listing is the
    deliverable; restore state is the bonus.
    """
    _c, s = stub
    s.add_client_error("list_objects_v2", service_error_code="InvalidRequest",
                       service_message="OptionalObjectAttributes is not supported "
                                       "for directory buckets",
                       http_status_code=400, expected_params=_EXPECTED)
    s.add_response("list_objects_v2", {
        "Contents": [{"Key": "a", "Size": 1, "StorageClass": "EXPRESS_ONEZONE"}],
        "KeyCount": 1, "IsTruncated": False,
    }, expected_params={"Bucket": BUCKET, "Prefix": "", "MaxKeys": 1000})

    conn = _db()
    try:
        out = s3.list_objects_v2(conn, provider, BUCKET, 1000, delimiter=None)
        assert out["success"] is True, out
        assert out["keys"] == ["a"], out
        # …and it says it does not know, rather than "nothing is restoring".
        assert out["restore_status_reported"] is False, out
        s.assert_no_pending_responses()
    finally:
        conn.close()


def test_a_real_error_is_not_retried_into_a_second_one(stub, provider):
    """The guard on the retry. NoSuchBucket must surface as itself — retrying it
    without the attribute produces the same failure and tells nobody anything.
    Only ONE response is queued, so a second call fails the test."""
    _c, s = stub
    s.add_client_error("list_objects_v2", service_error_code="NoSuchBucket",
                       service_message="The specified bucket does not exist",
                       http_status_code=404, expected_params=_EXPECTED)
    conn = _db()
    try:
        out = s3.list_objects_v2(conn, provider, BUCKET, 1000, delimiter=None)
        assert out["success"] is False
        assert out["error_code"] == "NoSuchBucket", out
        s.assert_no_pending_responses()
    finally:
        conn.close()
