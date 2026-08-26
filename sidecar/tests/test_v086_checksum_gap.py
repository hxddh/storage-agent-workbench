"""A checksum the client cannot verify is a provider gap, not an anonymous error.

botocore >= 1.36 asks for and validates flexible checksums by default
(``response_checksum_validation="when_supported"``). Against AWS that is free
integrity checking. Against the S3-compatible endpoints this product exists to
diagnose it is a known interop edge: a gateway that returns a checksum botocore
cannot verify — wrong algorithm, wrong value for a ranged read, a CRC64NVME
implementation that disagrees — makes the READ fail while the bytes are fine.

Before this, the product had no position on that and could not name it: the
failure came out as ``error_code: "FlexibleChecksumError"`` plus a raw message.
Technically honest, useless to an operator, and diagnosing precisely this class
of provider disagreement is the product's job (rule 18 — capability gaps are
reported as gaps, not hard failures).

The claim being tested is narrow on purpose. The object is NOT reported as
corrupt or unreadable: what failed is the client's verification of the
endpoint's checksum, which is a statement about the endpoint.
"""
from __future__ import annotations

import sqlite3
from typing import Any

import pytest
from botocore.exceptions import ClientError

from app import config
from app.s3 import client_factory
from app.s3 import tools as s3

pytest.importorskip("botocore")


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture()
def provider(client) -> str:
    return client.post("/cloud-providers", json={
        "name": "checksum-gap", "provider_type": "s3-compatible",
        "endpoint_url": "https://gw.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "mode": "readonly",
    }).json()["id"]


class _ChecksumRefusingClient:
    """Every call completes the transfer, then refuses on validation."""

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    def __getattr__(self, _name: str):
        def _raise(*_a: Any, **_k: Any):
            raise self._exc
        return _raise


def _flexible_checksum_error() -> BaseException:
    from botocore.exceptions import FlexibleChecksumError

    return FlexibleChecksumError(
        error_msg="Expected checksum CRC64NVME did not match calculated checksum")


def test_a_checksum_refusal_is_named_not_left_as_a_class_name(client, provider, monkeypatch):
    monkeypatch.setattr(client_factory, "build_s3_client",
                        lambda *a, **k: _ChecksumRefusingClient(_flexible_checksum_error()))
    conn = _db()
    try:
        out = s3.preview_object(conn, provider, "b", "k.json")
        assert out["success"] is False
        assert out["error_code"] == "checksum_validation_unsupported", out
        msg = out["error_message_sanitized"]
        # It must say what actually failed…
        assert "could not verify" in msg, msg
        # …and must NOT claim the object is corrupt, which is the wrong verdict
        # and the one an operator would act on destructively.
        assert "corrupt" in msg and "not evidence that the object is corrupt" in msg, msg
    finally:
        conn.close()


def test_the_same_naming_reaches_every_tool_that_shapes_an_error(client, provider, monkeypatch):
    """It lives in the shared shaper, so a range read gets it too — the point of
    fixing the class rather than one call site."""
    monkeypatch.setattr(client_factory, "build_s3_client",
                        lambda *a, **k: _ChecksumRefusingClient(_flexible_checksum_error()))
    conn = _db()
    try:
        out = s3.test_range_get(conn, provider, "b", "k.json", "bytes=0-9")
        assert out["success"] is False
        assert out["error_code"] == "checksum_validation_unsupported", out
    finally:
        conn.close()


def test_an_ordinary_error_is_still_reported_as_itself(client, provider, monkeypatch):
    """The guard: this must not swallow unrelated failures into a friendly gap."""
    boom = ClientError({"Error": {"Code": "NoSuchKey", "Message": "nope"}}, "HeadObject")
    monkeypatch.setattr(client_factory, "build_s3_client",
                        lambda *a, **k: _ChecksumRefusingClient(boom))
    conn = _db()
    try:
        out = s3.preview_object(conn, provider, "b", "k.json")
        assert out["success"] is False
        assert out["error_code"] != "checksum_validation_unsupported", out
    finally:
        conn.close()


def test_the_detector_matches_botocores_real_exception_types():
    """Pins the names this rests on. They are matched by type NAME, because the
    import path in botocore has moved before and a diagnosis that silently stops
    matching after a dependency bump is worse than one never written."""
    from botocore.exceptions import ChecksumError, FlexibleChecksumError

    assert s3._is_checksum_failure(FlexibleChecksumError(error_msg="x")) is True
    assert s3._is_checksum_failure(
        ChecksumError(checksum_type="crc32", expected_checksum="a",
                      actual_checksum="b")) is True
    assert s3._is_checksum_failure(ValueError("checksum mismatch")) is False
