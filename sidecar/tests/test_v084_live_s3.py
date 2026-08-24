"""The read-only tools, driven against a real S3 server with real state.

v0.76.0 pointed every tool at a real socket and asserted what happens when the
endpoint MISBEHAVES. That covered the failure half. The success half was still
asserted against canned XML: a document with a fixed `IsTruncated`, a fixed
version list, a fixed `Content-Range`. A tool can copy fields out of a fixed
document correctly and still be wrong about the protocol — the continuation
token it must echo back, the 206 it must distinguish from a 200, the 304 that
means "unchanged" rather than "empty".

So these tests assert the semantics the SERVER produces, through the app's own
provider row and client factory: really built, really signed, really addressed
path-style, really answered by something holding state.

Scope, stated plainly (see ``live_s3.py``): moto does not verify signatures, and
is not a specific S3-compatible product. Signature rejection and provider quirks
are NOT established here.
"""
from __future__ import annotations

import sqlite3

import pytest

from app import config
from app.s3 import config_tools as ct
from app.s3 import tools as s3
from tests.live_s3 import (AWKWARD_KEY, BODY, BUCKET, EMPTY_BUCKET, KEYS,
                           MPU_KEY, SEEDED, live_s3_endpoint)  # noqa: F401

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
KEY = KEYS[2]  # neither versioned nor deleted


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture()
def provider(client, live_s3_endpoint):  # noqa: F811
    """A provider row pointing at the live server — the app resolves the
    credentials and builds the client itself, as it would in production."""
    return client.post("/cloud-providers", json={
        "name": "live-gate", "provider_type": "s3-compatible",
        "endpoint_url": live_s3_endpoint, "region": "us-east-1",
        "addressing_style": "path", "access_key": ACCESS, "secret_key": SECRET,
        "mode": "readonly",
    }).json()["id"]


def test_credentials_and_bucket_reachability(client, provider):
    conn = _db()
    try:
        cred = s3.test_credentials(conn, provider)
        assert cred["success"] is True, cred
        assert BUCKET in {b["name"] for b in s3.list_buckets(conn, provider)["buckets"]}
        assert s3.head_bucket(conn, provider, BUCKET)["success"] is True
        # A bucket that genuinely does not exist, answered by the server.
        assert s3.head_bucket(conn, provider, "live-gate-absent")["success"] is False
    finally:
        conn.close()


def test_pagination_really_continues(client, provider):
    """The continuation token has to survive a round trip. A canned document
    cannot show that: its `NextContinuationToken` is whatever the fixture said,
    and page two is the same page again."""
    conn = _db()
    try:
        first = s3.list_objects_v2(conn, provider, BUCKET, max_keys=2,
                                   prefix="logs/", delimiter=None)
        assert first["success"] is True and first["is_truncated"] is True
        token = first.get("next_token")
        assert token, first

        second = s3.list_objects_v2(conn, provider, BUCKET, max_keys=2,
                                    prefix="logs/", delimiter=None,
                                    continuation_token=token)
        assert second["success"] is True
        page1 = set(first["keys"])
        page2 = set(second["keys"])
        assert page1 and page2 and page1.isdisjoint(page2), (page1, page2)
    finally:
        conn.close()


def test_head_object_reports_the_servers_size_and_etag(client, provider):
    conn = _db()
    try:
        out = s3.head_object(conn, provider, BUCKET, KEY)
        assert out["success"] is True
        assert out["size"] == len(BODY)          # the server's byte count
        assert out["etag"]                        # a real ETag, not a fixture's
        assert s3.head_object(conn, provider, BUCKET, "logs/absent.json")["success"] is False
    finally:
        conn.close()


def test_range_get_is_a_206_not_a_200(client, provider):
    """A partial read and a full read differ by status code, and only a real
    server assigns it."""
    conn = _db()
    try:
        out = s3.test_range_get(conn, provider, BUCKET, KEY, "bytes=0-9")
        assert out["success"] is True, out
        assert out.get("status_code") == 206, out
        assert out.get("bytes_returned") == 10, out
    finally:
        conn.close()


def test_conditional_get_is_a_real_304(client, provider):
    """The three-way outcome (304 / changed ETag / provider ignored the header)
    can only be told apart by a server that implements the header."""
    conn = _db()
    try:
        etag = s3.head_object(conn, provider, BUCKET, KEY)["etag"]
        out = s3.test_conditional_get(conn, provider, BUCKET, KEY, etag)
        assert out["success"] is True, out
        assert out.get("status_code") == 304, out
        assert out.get("etag_matches") is True, out   # 304 == unchanged

        stale = s3.test_conditional_get(conn, provider, BUCKET, KEY, '"deadbeef"')
        assert stale["success"] is True, stale
        assert stale.get("status_code") == 200 and stale.get("etag_matches") is False, stale
    finally:
        conn.close()


def test_versions_and_delete_markers_are_the_servers_own(client, provider):
    conn = _db()
    try:
        out = s3.list_object_versions(conn, provider, BUCKET, prefix="logs/")
        assert out["success"] is True, out
        assert out["version_count"] >= len(KEYS) + 1   # one key has two versions
        assert out["delete_marker_count"] >= 1         # the deleted key
        assert out["version_count"] > out["delete_marker_count"]
    finally:
        conn.close()


def test_incomplete_multipart_upload_and_its_parts(client, provider):
    """State that exists only because an upload was started and never finished
    — there is no way to fake this into a stateless document and still have
    list_upload_parts take the upload id back."""
    conn = _db()
    try:
        uploads = s3.list_multipart_uploads(conn, provider, BUCKET)
        assert uploads["success"] is True, uploads
        assert uploads["upload_count"] == 1, uploads
        assert MPU_KEY in uploads["sample_keys"], uploads

        parts = s3.list_upload_parts(conn, provider, BUCKET, MPU_KEY,
                                     SEEDED["upload_id"])
        assert parts["success"] is True, parts
        assert parts["part_count"] == 1, parts
        assert parts["total_bytes"] == 5 * 1024 * 1024, parts
    finally:
        conn.close()


def test_preview_object_reads_the_real_bytes(client, provider):
    conn = _db()
    try:
        out = s3.preview_object(conn, provider, BUCKET, KEY)
        assert out["success"] is True, out
        assert '"status":200' in (out.get("content") or ""), out
    finally:
        conn.close()


def test_unconfigured_config_reads_map_to_not_configured(client, provider):
    """The server answers each unconfigured sub-resource with its own real error
    code (ServerSideEncryptionConfigurationNotFoundError, NoSuchLifecycle...).
    Those codes reaching `not_configured` — rather than `error` — is the
    difference between "confirmed absent" and "unknown", which the whole
    posture-honesty floor rests on."""
    conn = _db()
    try:
        summary = ct.get_bucket_config_summary(conn, provider, BUCKET)
        assert summary["success"] is True, summary
        items = summary["config_items"]   # aspect -> status string
        for aspect in ("encryption", "lifecycle", "policy", "public_access_block"):
            assert items[aspect] == ct.NOT_CONFIGURED, (aspect, items[aspect])
        # Versioning IS configured on this bucket — a positive read from the
        # same call, so the above is not just "everything says not_configured".
        assert items["versioning"] == ct.AVAILABLE, items["versioning"]
        assert summary["overall_status"] == "reviewed", summary["overall_status"]
    finally:
        conn.close()


def test_empty_bucket_is_empty_not_broken(client, provider):
    """A zero-result listing and a failed listing must not look alike."""
    conn = _db()
    try:
        out = s3.list_objects_v2(conn, provider, EMPTY_BUCKET, max_keys=10)
        assert out["success"] is True and out["keys"] == [] and out["is_truncated"] is False
    finally:
        conn.close()


def test_no_credential_is_echoed_by_any_live_call(client, provider):
    """Rule 15, over the wire rather than over a stub."""
    import json as _json

    conn = _db()
    try:
        blobs = [
            s3.test_credentials(conn, provider),
            s3.list_objects_v2(conn, provider, BUCKET, max_keys=3),
            s3.head_object(conn, provider, BUCKET, KEY),
            s3.preview_object(conn, provider, BUCKET, KEY),
            ct.get_bucket_config_summary(conn, provider, BUCKET),
        ]
        dumped = _json.dumps(blobs, default=str)
        assert SECRET not in dumped
        assert ACCESS not in dumped
    finally:
        conn.close()


def test_a_key_that_needs_url_encoding_round_trips(client, provider):
    """Space, `+`, `#`, `?`, `=` and non-ASCII in one key.

    This is the class of request bug a canned double structurally cannot expose:
    it never encodes anything, so a tool that mangles the key still "finds" the
    object in the fixture. Against a server, a mis-encoded key is simply a
    different key and the read misses.
    """
    conn = _db()
    try:
        head = s3.head_object(conn, provider, BUCKET, AWKWARD_KEY)
        assert head["success"] is True, head
        assert head["size"] == len(BODY), head

        prev = s3.preview_object(conn, provider, BUCKET, AWKWARD_KEY)
        assert prev["success"] is True, prev
        assert '"status":200' in (prev.get("content") or ""), prev

        rng = s3.test_range_get(conn, provider, BUCKET, AWKWARD_KEY, "bytes=0-9")
        assert rng["success"] is True and rng.get("status_code") == 206, rng

        # And it comes back in a listing, spelled the same way it went in.
        listed = s3.list_objects_v2(conn, provider, BUCKET, max_keys=100,
                                    prefix="logs/", delimiter=None)
        assert AWKWARD_KEY in listed["keys"], listed["keys"]
    finally:
        conn.close()
