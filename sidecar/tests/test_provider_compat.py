"""Provider-compatibility matrix (rule 18).

The product targets S3-COMPATIBLE providers (R2, MinIO, GCS-XML, B2, Ceph RGW),
which deviate from AWS in well-known ways: many don't implement object-lock /
tagging / ACL / versioning / replication / notification APIs, some reject an
unimplemented op with a bare 501/405 (no error code), some ignore conditional
headers. Rule 18 says a capability GAP must degrade to ``provider_unsupported``
(or a benign "not configured"), never a hard failure or a faked "clean" result —
while a genuine PERMISSION problem (AccessDenied/403) must stay distinct.

Most existing S3 tests stub AWS-shaped happy paths. This file pins the
DEGRADATION behavior across the deviation shapes, at both the central mappers
and the individual read-only tools.
"""

from __future__ import annotations

import json
import sqlite3

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber

from app import config
from app.s3 import client_factory
from app.s3 import config_tools as cfg
from app.s3 import tools as s3

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
BUCKET = "bucket-alpha"


@pytest.fixture()
def cloud_id(client):
    body = {
        "name": "compat-provider", "provider_type": "s3-compatible",
        "endpoint_url": "https://s3.compat.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": ACCESS, "secret_key": SECRET,
        "mode": "readonly",
    }
    return client.post("/cloud-providers", json=body).json()["id"]


@pytest.fixture()
def stub(monkeypatch):
    c = boto3.client("s3", region_name="us-east-1", aws_access_key_id="stub",
                     aws_secret_access_key="stub", endpoint_url="https://s3.compat.example.com")
    s = Stubber(c)
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: c)
    s.activate()
    yield c, s
    s.deactivate()


def _db():
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def _err(code: str | None, http: int | None, message: str = "") -> ClientError:
    resp: dict = {"Error": {}}
    if code is not None:
        resp["Error"]["Code"] = code
    if message:
        resp["Error"]["Message"] = message
    if http is not None:
        resp["ResponseMetadata"] = {"HTTPStatusCode": http}
    return ClientError(resp, "Op")


# --- the deviation shapes, as (code, http) --------------------------------------
# Capability GAPS — must degrade to provider_unsupported.
_GAP_SHAPES = [
    ("NotImplemented", 501),   # AWS-style / MinIO for some ops
    ("MethodNotAllowed", 405),
    ("NotSupported", 400),     # detected by CODE (http not in the 501/405 set)
    ("Unsupported", 400),      # detected by CODE
    (None, 501),               # code-less 501 (a bare gateway rejection)
    (None, 405),               # code-less 405 Method Not Allowed
]
# PERMISSION problems — must stay DENIED, never masked as "unsupported"/"clean".
_DENIED_SHAPES = [("AccessDenied", 403), ("Forbidden", 403), (None, 403)]


# --- 1. central detectors -------------------------------------------------------

@pytest.mark.parametrize("code,http", _GAP_SHAPES)
def test_is_unsupported_detects_every_gap_shape(code, http):
    assert s3._is_unsupported(_err(code, http)) is True


@pytest.mark.parametrize("code,http", _DENIED_SHAPES)
def test_is_unsupported_does_not_swallow_permission_errors(code, http):
    assert s3._is_unsupported(_err(code, http)) is False


class _RaisingClient:
    def __init__(self, exc):
        self._exc = exc

    def __getattr__(self, _name):
        def _call(**_kwargs):
            raise self._exc
        return _call


@pytest.mark.parametrize("code,http", _GAP_SHAPES)
def test_config_read_maps_gaps_to_provider_unsupported(code, http):
    out = cfg._read(_RaisingClient(_err(code, http)), "get_bucket_replication", Bucket=BUCKET)
    assert out["status"] == cfg.PROVIDER_UNSUPPORTED


@pytest.mark.parametrize("code,http", _DENIED_SHAPES)
def test_config_read_maps_permission_to_access_denied(code, http):
    out = cfg._read(_RaisingClient(_err(code, http)), "get_bucket_replication", Bucket=BUCKET)
    assert out["status"] == cfg.ACCESS_DENIED


def test_config_read_rejects_a_mutating_method_name():
    # Defense-in-depth: the getattr-by-name reader must refuse a non-read op.
    with pytest.raises(ValueError):
        cfg._read(_RaisingClient(_err("x", 500)), "put_bucket_policy", Bucket=BUCKET)


# --- 2. object-level read tools degrade, never raise ----------------------------
# Each tool: (function, stubber-method, extra kwargs, is-gap? predicate). NOTE the
# gap is expressed INCONSISTENTLY across tools — a `*_status` string on the
# object-metadata tools, a boolean `provider_unsupported` on the list tools. The
# predicates encode that reality (and pin it against silent drift).
_PU = s3.PROVIDER_UNSUPPORTED
_OBJECT_TOOLS = [
    (s3.get_object_tagging, "get_object_tagging", {"key": "k"},
     lambda o: o.get("tagging_status") == _PU),
    (s3.get_object_acl, "get_object_acl", {"key": "k"},
     lambda o: o.get("acl_status") == _PU),
    (s3.get_object_attributes, "get_object_attributes", {"key": "k"},
     lambda o: o.get("attributes_status") == _PU),
    (s3.list_object_versions, "list_object_versions", {},
     lambda o: o.get("provider_unsupported") is True),
    (s3.list_multipart_uploads, "list_multipart_uploads", {},
     lambda o: o.get("provider_unsupported") is True),
]


@pytest.mark.parametrize("fn,method,kwargs,is_gap", _OBJECT_TOOLS)
@pytest.mark.parametrize("code,http", _GAP_SHAPES)
def test_object_tool_reports_provider_unsupported_not_failure(
    client, cloud_id, stub, fn, method, kwargs, is_gap, code, http
):
    _, s = stub
    s.add_client_error(method, service_error_code=code or "", http_status_code=http or 400)
    with _db() as conn:
        out = fn(conn, cloud_id, BUCKET, **kwargs)
    # A capability gap is a SUCCESSFUL probe with the gap flagged — not a crash,
    # not success=False, and never a leaked raw error.
    assert is_gap(out), f"{method} {code}/{http} → {out}"
    assert out.get("success") is True
    for leaked in (ACCESS, SECRET):
        assert leaked not in json.dumps(out)


@pytest.mark.parametrize("fn,method,kwargs,is_gap", _OBJECT_TOOLS)
@pytest.mark.parametrize("code,http", _DENIED_SHAPES)
def test_object_tool_permission_error_is_not_masked_as_unsupported(
    client, cloud_id, stub, fn, method, kwargs, is_gap, code, http
):
    _, s = stub
    s.add_client_error(method, service_error_code=code or "", http_status_code=http or 403)
    with _db() as conn:
        out = fn(conn, cloud_id, BUCKET, **kwargs)
    # A permission problem must NOT be reported as a capability gap.
    assert not is_gap(out)


# --- 3. review engine degrades to findings, never crashes -----------------------
# Uses a client that raises the SAME gap error for EVERY method (order-independent,
# unlike a Stubber queue) — the real "provider implements none of the config
# surface" case.

@pytest.mark.parametrize("review_fn", [
    cfg.review_bucket_security,
    cfg.review_bucket_lifecycle,
    cfg.review_bucket_observability,
    cfg.review_bucket_cost_optimization,
])
def test_review_on_fully_unsupported_provider_yields_findings_not_crash(
    client, cloud_id, monkeypatch, review_fn
):
    monkeypatch.setattr(client_factory, "build_s3_client",
                        lambda *a, **k: _RaisingClient(_err("NotImplemented", 501)))
    with _db() as conn:
        out = review_fn(conn, cloud_id, BUCKET)  # must NOT raise
    assert isinstance(out.get("findings"), list)
    # At least one finding names the capability gap; the run is not a hard failure.
    assert any("unsupported" in json.dumps(f).lower() for f in out["findings"])
    for leaked in (ACCESS, SECRET):
        assert leaked not in json.dumps(out)
