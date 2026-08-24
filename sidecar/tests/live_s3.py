"""A REAL, stateful S3 server the read-only tools can be driven against.

Three layers of S3 test double already exist here, and each stops short of the
same thing:

- the botocore ``Stubber`` in ``test_s3_tools.py`` replaces the response after
  the request is built — it never speaks HTTP;
- ``fake_s3.py`` is a socket that answers canned XML, so the request half is
  real but there is no state behind it;
- ``fake_endpoint.py`` is a socket that answers the way a *hostile* endpoint
  answers, which is what v0.76.0 needed — the failure half.

What none of them covers is the **success half against real state**: pagination
that actually continues, a version list that actually has delete markers in it,
a range GET that actually returns 206 with a Content-Range, a conditional GET
that actually returns 304, a multipart upload that actually has parts. Those
semantics are produced by the server, so a double that hands back a fixed
document can assert only that the tool copies fields out of it.

This module runs `moto`'s S3 server — a full implementation with real object
state — on a loopback port, and the tools reach it through the app's own
provider row and client factory. So the request is really built, really signed,
really addressed path-style, and really answered by something that keeps state.

**What this does NOT establish**, stated here so no one reads the gate as more
than it is:

- **No signature verification.** moto accepts a wrong secret key (verified, not
  assumed). Proving that a rejected signature is handled correctly needs a
  server that checks one — MinIO, Ceph, garage — which is a container, not a
  pip install.
- **Not AWS, and not a specific S3-compatible product.** Provider-specific
  quirks — MinIO's 501s on config sub-resources, Ceph's pagination edge cases —
  are still only ever found by hand.

Missing dependency is a FAILURE, not a skip: ``moto[server]`` is in the dev
extra, and ``live_s3_endpoint`` raises if it cannot import. A gate that quietly
skips itself is how a suite stops testing something without anyone noticing —
the exact defect class this project has spent several releases removing from the
product.
"""
from __future__ import annotations

from typing import Any

import pytest

# Fixture bucket contents. Small, but shaped so every stateful semantic the
# read-only whitelist depends on has something real to observe.
BUCKET = "live-gate-bucket"
EMPTY_BUCKET = "live-gate-empty"
KEYS = [f"logs/2026/08/part-{i:04d}.json" for i in range(5)]
BODY = b'{"ts":"2026-08-18T00:00:00Z","status":200,"bytes":1024}\n' * 4
VERSIONED_KEY = KEYS[0]
DELETED_KEY = KEYS[1]
MPU_KEY = "uploads/incomplete.bin"
# A key with everything a URL cares about: space, plus, hash, question mark,
# equals, and non-ASCII. A canned double never encodes anything, so key
# encoding is the one class of request bug it structurally cannot expose.
AWKWARD_KEY = "logs/2026-08/a b+c#d?e=1/ünïcode .json"


def _require_moto() -> Any:
    try:
        from moto.server import ThreadedMotoServer
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise RuntimeError(
            "moto[server] is required for the live-endpoint gate and is declared "
            "in the dev extra (pip install -e '.[dev]'). This raises instead of "
            "skipping on purpose: a gate that skips itself silently stops being "
            "a gate."
        ) from exc
    return ThreadedMotoServer


@pytest.fixture(scope="module")
def live_s3_endpoint():
    """Start a real S3 server, seed it, and yield its endpoint URL."""
    threaded_moto_server = _require_moto()
    server = threaded_moto_server(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    try:
        # `list_multipart_uploads` deliberately does not hand back upload ids
        # (sanitized to key samples), so the seeder publishes the one it created
        # for the ListParts test to use.
        SEEDED["upload_id"] = _seed(endpoint)
        yield endpoint
    finally:
        server.stop()


SEEDED: dict[str, str] = {}


def _seed(endpoint: str) -> str:
    """Create the fixture state with a plain boto3 client (not the app's)."""
    import boto3
    from botocore.config import Config

    s3 = boto3.client(
        "s3", endpoint_url=endpoint, region_name="us-east-1",
        aws_access_key_id="AKIAIOSFODNN7EXAMPLE",
        aws_secret_access_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        config=Config(s3={"addressing_style": "path"}),
    )
    s3.create_bucket(Bucket=BUCKET)
    s3.create_bucket(Bucket=EMPTY_BUCKET)
    s3.put_bucket_versioning(Bucket=BUCKET,
                             VersioningConfiguration={"Status": "Enabled"})
    for key in KEYS:
        s3.put_object(Bucket=BUCKET, Key=key, Body=BODY,
                      ContentType="application/json")
    s3.put_object(Bucket=BUCKET, Key=AWKWARD_KEY, Body=BODY,
                  ContentType="application/json")
    # A second version, and a delete marker — the pileup the tools report on.
    s3.put_object(Bucket=BUCKET, Key=VERSIONED_KEY, Body=BODY + b"extra\n",
                  ContentType="application/json")
    s3.delete_object(Bucket=BUCKET, Key=DELETED_KEY)
    # An incomplete multipart upload with one real part.
    mpu = s3.create_multipart_upload(Bucket=BUCKET, Key=MPU_KEY)
    s3.upload_part(Bucket=BUCKET, Key=MPU_KEY, UploadId=mpu["UploadId"],
                   PartNumber=1, Body=b"\0" * (5 * 1024 * 1024))
    return mpu["UploadId"]
