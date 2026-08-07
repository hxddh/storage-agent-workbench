"""v0.66.0 — the S3 tools, driven against a real socket for the first time.

Everything below the tools was covered with a botocore ``Stubber``, which
replaces the client's response *after* the request is built. That covers response
handling and nothing else: it never serializes a request, never signs one, never
sees a URL, and cannot tell path-style from virtual-host addressing — which is
the single most common S3-compatible misconfiguration, and the thing this product
exists to diagnose.

`tests/fake_s3.py` is a socket that answers S3 XML. These drive the read-only
tools through boto3 into it and assert on both halves: the request the client
actually BUILT, and how a real HTTP status maps into this app's sanitized result.
"""
from __future__ import annotations

import sqlite3

import pytest

from app import config
from app.s3 import client_factory
from app.s3 import tools as s3

from .fake_s3 import FakeS3

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"


@pytest.fixture
def provider(client, tmp_path):
    """A cloud provider pointed at a live fake S3; yields (conn, id, fake)."""
    with FakeS3(buckets={"acme-logs": ["logs/2026/a.parquet", "logs/2026/b.parquet"],
                         "acme-backups": ["db/full.dump"]}) as fake:
        created = client.post("/cloud-providers", json={
            "name": "acme", "provider_type": "s3-compatible",
            "endpoint_url": fake.endpoint_url, "region": "us-east-1",
            "addressing_style": "path",
            "access_key": ACCESS, "secret_key": SECRET,
        })
        assert created.status_code in (200, 201), created.text
        pid = created.json()["id"]
        client_factory.invalidate_provider(pid)
        conn = sqlite3.connect(config.db_path())
        conn.row_factory = sqlite3.Row
        try:
            yield conn, pid, fake
        finally:
            conn.close()
            client_factory.invalidate_provider(pid)


# --- the request half: what boto3 actually built ----------------------------


def test_path_style_puts_the_bucket_in_the_PATH(provider):
    """The configured addressing style has to reach the wire. A Stubber cannot
    see this at all, and getting it wrong is the most common S3-compatible
    misconfiguration this product diagnoses."""
    conn, pid, fake = provider
    s3.head_bucket(conn, pid, "acme-logs")
    assert any(p.startswith("/acme-logs") for p in fake.paths()), fake.paths()


def test_the_credentials_are_signed_in_not_sent_as_query_params(provider):
    """A presigned-style URL would put the access key id in the path. SigV4
    header auth keeps it in Authorization, which the redaction layer strips from
    anything persisted."""
    conn, pid, fake = provider
    s3.test_credentials(conn, pid)
    assert all(ACCESS not in p for p in fake.paths()), fake.paths()
    assert any("Authorization" in h for _m, _p, h in fake.requests)


def test_a_list_is_bounded_by_max_keys_on_the_wire(provider):
    """Rule 12: a bounded scan must be bounded in the REQUEST, not filtered after
    the fact — otherwise the provider still does the full listing."""
    conn, pid, fake = provider
    s3.list_objects_v2(conn, pid, "acme-logs", max_keys=1, delimiter="")
    assert any("max-keys=1" in p for p in fake.paths()), fake.paths()


# --- the response half: real HTTP into this app's own shape -----------------


def test_credentials_succeed_against_a_live_endpoint(provider):
    conn, pid, _ = provider
    out = s3.test_credentials(conn, pid)
    assert out["success"] is True
    assert "acme" in (out["identity_hint"] or "")


def test_listing_returns_the_real_objects(provider):
    conn, pid, _ = provider
    out = s3.list_objects_v2(conn, pid, "acme-logs", max_keys=10, delimiter="")
    assert out["success"] is True, out
    assert out["key_count"] == 2, out
    assert "logs/2026/a.parquet" in out["sample_keys"], out


def test_head_bucket_on_a_missing_bucket_is_a_clean_failure(provider):
    """A 404 from the endpoint becomes a structured result, not an exception."""
    conn, pid, _ = provider
    out = s3.head_bucket(conn, pid, "not-a-bucket")
    assert out["success"] is False
    assert out.get("error_code")


@pytest.mark.parametrize("status,code", [
    (404, "NoSuchBucket"),
    (400, "InvalidAccessKeyId"),
    (403, "SignatureDoesNotMatch"),
    (500, "InternalError"),
])
def test_a_real_failure_maps_to_a_sanitized_result(provider, status, code):
    conn, pid, fake = provider
    fake.fail_with = (status, code, "something went wrong at the endpoint")
    out = s3.test_credentials(conn, pid)
    assert out["success"] is False, out
    assert out["error_code"] == code
    # The message is carried, sanitized — never the raw XML body.
    assert "<Error>" not in (out.get("error_message_sanitized") or "")


def test_denied_LISTBUCKETS_still_means_the_credentials_are_good(provider):
    """Not a failure, and the distinction matters: plenty of S3 deployments deny
    `s3:ListAllMyBuckets` to perfectly valid credentials. Reporting that as
    "your credentials are broken" would send the operator to rotate keys that
    were never the problem.

    Written after asserting the opposite and being wrong — the product's
    behaviour here is deliberate and this pins it.
    """
    conn, pid, fake = provider
    fake.fail_with = (403, "AccessDenied", "not authorized to perform s3:ListAllMyBuckets")
    out = s3.test_credentials(conn, pid)
    assert out["success"] is True, out
    assert "denied" in (out["identity_hint"] or "").lower()


def test_a_genuine_auth_failure_is_still_a_failure(provider):
    """The other side of the same 403: an auth-failure CODE must not be waved
    through as "authenticated but denied"."""
    conn, pid, fake = provider
    fake.fail_with = (403, "InvalidAccessKeyId", "the access key does not exist")
    out = s3.test_credentials(conn, pid)
    assert out["success"] is False, out


def test_an_endpoint_without_ListBuckets_is_a_gap_not_a_failure(provider):
    """Rule 18: a capability gap on an S3-compatible endpoint is reported as
    `Provider unsupported`, never as broken credentials."""
    conn, pid, fake = provider
    fake.fail_with = (501, "NotImplemented", "A header you provided is not implemented")
    out = s3.test_credentials(conn, pid)
    assert out["success"] is True, out
    assert "unsupported" in (out["identity_hint"] or "").lower()


def test_no_credential_value_appears_in_any_result(provider):
    """Rules 1/15, checked against the tool's own output rather than the code."""
    conn, pid, fake = provider
    fake.fail_with = (403, "AccessDenied", f"key {ACCESS} with secret {SECRET} denied")
    out = s3.test_credentials(conn, pid)
    blob = str(out)
    assert ACCESS not in blob
    assert SECRET not in blob


def test_get_bucket_location_answers_where_the_bucket_lives(provider):
    conn, pid, _ = provider
    out = s3.get_bucket_location(conn, pid, "acme-logs")
    assert out["success"] is True
    assert out["bucket_region"] == "us-east-1", out
    assert out["configured_region"] == "us-east-1", out


# --- rules, checked against real responses ----------------------------------


def test_the_sample_is_capped_however_many_keys_come_back(client):
    """Rule 16: at most 20 sample keys. Checked against a bucket that really
    returns 100, over HTTP, rather than against a hand-built response."""
    with FakeS3(buckets={"big": [f"data/part-{i:04d}.parquet" for i in range(100)]}) as fake:
        pid = client.post("/cloud-providers", json={
            "name": "big", "provider_type": "s3-compatible",
            "endpoint_url": fake.endpoint_url, "region": "us-east-1",
            "addressing_style": "path", "access_key": ACCESS, "secret_key": SECRET,
        }).json()["id"]
        conn = sqlite3.connect(config.db_path())
        conn.row_factory = sqlite3.Row
        try:
            out = s3.list_objects_v2(conn, pid, "big", max_keys=100, delimiter="")
            assert out["key_count"] == 100, out
            assert len(out["sample_keys"]) <= 20, len(out["sample_keys"])
        finally:
            conn.close()
            client_factory.invalidate_provider(pid)


def test_a_prefix_is_applied_at_the_endpoint_not_after(provider):
    """A prefix filtered client-side would still make the provider list the whole
    bucket — the cost the bound exists to avoid."""
    conn, pid, fake = provider
    out = s3.list_objects_v2(conn, pid, "acme-logs", max_keys=10,
                             prefix="logs/2026/", delimiter="")
    assert out["success"] is True, out
    assert any("prefix=logs%2F2026%2F" in p or "prefix=logs/2026/" in p
               for p in fake.paths()), fake.paths()


def test_the_addressing_probe_refuses_to_guess_against_an_IP(provider):
    """The flagship probe. botocore never virtual-hosts against an IP endpoint —
    it silently sends the identical path-style URL — so probing both would report
    "both work" on the single most common S3-compatible setup (MinIO/Ceph on an
    IP:port). The fake endpoint IS an IP, which is what makes this testable at
    all: the probe must say it cannot be tested rather than answer wrongly.
    """
    conn, pid, _ = provider
    out = s3.test_path_style_vs_virtual_host(conn, pid, "acme-logs")
    assert out["virtual_hosted_result"]["not_testable"] is True, out
    assert out["path_style_result"]["success"] is True, out


def test_a_bucket_that_is_not_there_is_named_plainly(provider):
    """The bucket NAME is a DNS-style identifier, not secret material, and the
    answer is useless without it."""
    conn, pid, _ = provider
    out = s3.list_objects_v2(conn, pid, "no-such-bucket", max_keys=10, delimiter="")
    assert out["success"] is False
    assert out.get("error_code") == "NoSuchBucket", out
