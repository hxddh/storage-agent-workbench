"""v0.52.0 — making a failure actionable, and reading the columns we already had.

Three gaps, all in the diagnostic core rather than the chat surface.

**Live probes discarded the metadata that makes a failure escalatable.** Every
live S3 tool returns ``_client_error_fields`` on failure, and it captured only
code / message / status. botocore hands over ``RequestId``, ``HostId``,
``RetryAttempts`` and the response headers on the same object — all dropped. An
unexplained 500 from an S3-compatible gateway was therefore a dead end, even
though the offline triage parser has always extracted ``request_id`` from pasted
text: the same product, two standards.

**There was no cheap region probe.** Region/endpoint mismatch is the most common
S3-compatible misconfiguration and cost a 15-call ``get_bucket_config_summary``
to diagnose, because ``get_bucket_location`` was not a tool.

**The access-log engine parsed ``latency_ms`` and ``bytes_sent`` and read
neither.** "Why is it slow" and "why is it expensive" had no numbers behind them.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from botocore.exceptions import ClientError

from app.analysis import access_logs
from app.s3 import tools


def _err(code: str, status: int, *, headers: dict[str, str] | None = None,
         message: str = "boom", retries: int = 0) -> ClientError:
    return ClientError({
        "Error": {"Code": code, "Message": message},
        "ResponseMetadata": {
            "HTTPStatusCode": status,
            "RequestId": "8A9F2C1B4D6E0000",
            "HostId": "hostidbase64==",
            "RetryAttempts": retries,
            "HTTPHeaders": headers or {},
        },
    }, "HeadBucket")


# --- A: failure metadata -----------------------------------------------------


def test_a_failure_carries_the_ids_a_provider_will_ask_for():
    out = tools._client_error_fields(_err("InternalError", 500))
    assert out["error_code"] == "InternalError"
    # Without these, "the gateway 500'd and we don't know why" has no next step.
    assert out["request_id"] == "8A9F2C1B4D6E0000"
    assert out["host_id"] == "hostidbase64=="


def test_a_silently_retried_request_says_so():
    out = tools._client_error_fields(_err("SlowDown", 503, retries=3))
    # boto3 retries throttling transparently, so a slow turn otherwise looked
    # like an unexplained pause. This is the explanation.
    assert out["retry_attempts"] == 3


def test_captured_headers_keep_diagnostics_and_drop_secrets():
    out = tools._client_error_fields(_err("AccessDenied", 403, headers={
        "x-amz-request-id": "R1", "x-amz-id-2": "H1", "server": "AmazonS3",
        "authorization": "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/x, Signature=dead",
        "set-cookie": "sess=topsecret",
    }))
    h = out["headers_sanitized"]
    assert h["x-amz-request-id"] == "R1" and h["server"] == "AmazonS3"
    # Rule 15 — this dict is persisted and shown.
    assert "AKIAIOSFODNN7EXAMPLE" not in str(h)
    assert "topsecret" not in str(h)


def test_a_redirect_reports_where_the_bucket_actually_is():
    out = tools._client_error_fields(
        _err("PermanentRedirect", 301, headers={"x-amz-bucket-region": "us-west-2"}))
    # The header is the reliable source: AWS repeats the region in its message
    # prose, most S3-compatible gateways do not.
    assert out["bucket_region"] == "us-west-2"


def test_no_bucket_region_is_invented_when_the_header_is_absent():
    out = tools._client_error_fields(_err("NoSuchBucket", 404))
    assert "bucket_region" not in out


def test_the_failure_line_shown_to_the_reader_carries_the_request_id():
    from app.agent_runtime import session_tools

    line = session_tools._summarize(
        {"success": False, "error_code": "InternalError", "request_id": "8A9F2C1B4D6E0000"})
    assert "InternalError" in line and "8A9F2C1B4D6E0000" in line
    # A failure with no id must not grow a dangling separator.
    assert session_tools._summarize({"success": False, "error_code": "NoSuchKey"}) == "NoSuchKey"


def test_every_live_tool_inherits_the_metadata():
    """The point of putting it in the shared helper rather than per tool."""
    src = Path(tools.__file__).read_text()
    users = len(re.findall(r"_client_error_fields\(", src))
    assert users > 15, f"expected the failure shape to be shared, found {users} call sites"


# --- B: the cheap region probe ----------------------------------------------


class _FakeClient:
    def __init__(self, *, location=None, exc=None):
        self._location, self._exc = location, exc

    def get_bucket_location(self, **_):
        if self._exc:
            raise self._exc
        return {"LocationConstraint": self._location,
                "ResponseMetadata": {"RequestId": "R2", "HTTPHeaders": {}}}


@pytest.fixture()
def probe(monkeypatch):
    """get_bucket_location against a fake client, with a chosen provider config."""
    def _run(*, location=None, exc=None, region="us-east-1", endpoint=None):
        cfg = type("Cfg", (), {"region": region, "endpoint_url": endpoint,
                               "provider_type": "aws"})()
        monkeypatch.setattr(tools.client_factory, "load_provider", lambda *a, **k: cfg)
        monkeypatch.setattr(tools.client_factory, "build_s3_client",
                            lambda *a, **k: _FakeClient(location=location, exc=exc))
        return tools.get_bucket_location(None, "p1", "acme-logs")
    return _run


def test_location_probe_reports_the_region_and_compares_it(probe):
    out = probe(location="us-west-2", region="us-east-1")
    assert out["success"] and out["bucket_region"] == "us-west-2"
    # The whole point: it does not just report, it answers "is this my problem".
    assert out["region_mismatch"] is True
    assert out["configured_region"] == "us-east-1"


def test_an_empty_location_constraint_is_us_east_1_on_aws(probe):
    # AWS returns "" for us-east-1. Treating that as unknown would make the most
    # common region the one region we cannot report.
    out = probe(location=None, region="us-east-1")
    assert out["bucket_region"] == "us-east-1"
    assert out["region_mismatch"] is False


def test_an_empty_location_is_not_invented_as_us_east_1_on_a_gateway(probe):
    # A MinIO/Ceph endpoint that does not partition by region answers empty; the
    # honest report is "unknown", not a fabricated AWS region.
    out = probe(location=None, region="", endpoint="https://minio.example.com")
    assert out["bucket_region"] is None
    assert out["region_mismatch"] is None


def test_no_mismatch_is_claimed_when_one_side_is_unknown(probe):
    out = probe(location="us-west-2", region="")
    # An unset region on a custom endpoint is normal, not a fault.
    assert out["region_mismatch"] is None


def test_a_redirect_still_answers_the_question(probe):
    out = probe(exc=_err("PermanentRedirect", 301,
                         headers={"x-amz-bucket-region": "eu-central-1"}),
                region="us-east-1")
    # The configured endpoint cannot serve the bucket — and that IS the finding.
    assert out["success"] and out["bucket_region"] == "eu-central-1"
    assert out["region_mismatch"] is True


def test_a_provider_without_the_api_is_a_gap_not_a_failure(probe):
    out = probe(exc=_err("NotImplemented", 501))
    # Rule 18.
    assert out["success"] and out["provider_unsupported"] is True


def test_a_real_failure_stays_a_failure(probe):
    out = probe(exc=_err("AccessDenied", 403))
    assert out["success"] is False and out["error_code"] == "AccessDenied"
    assert out["request_id"] == "8A9F2C1B4D6E0000"


def test_the_probe_is_registered_as_an_agent_tool():
    src = Path(__file__).parent.parent.joinpath(
        "app/agent_runtime/session_tools.py").read_text()
    assert "def get_bucket_location(" in src
    assert re.search(r"tools = \[[^\]]*get_bucket_location", src, re.S)


# --- C: the columns the log engine already had -------------------------------


LOG = "\n".join(
    # AWS-style-ish JSONL: the parser accepts this shape and fills latency_ms /
    # bytes_sent, which nothing read before v0.52.0.
    '{"timestamp": "2026-08-05T%02d:00:00Z", "method": "GET", "key": "%s", '
    '"status_code": %d, "bytes_sent": %d, "latency_ms": %d, "client_ip": "10.0.0.%d", '
    '"user_agent": "aws-cli/2"}' % (h % 24, key, status, size, lat, ip)
    for h, key, status, size, lat, ip in (
        [(i, "video/big.mp4", 200, 10_000_000, 40, 7) for i in range(300)]
        + [(i, "thumbs/a.jpg", 200, 900, 30, 8) for i in range(60)]
        + [(i, "thumbs/b.jpg", 403, 0, 5000, 9) for i in range(60)]
    )
)


@pytest.fixture()
def metrics(tmp_path):
    # The engine's own ingest path, so the columns are populated exactly as they
    # are in production.
    src, duck_path = tmp_path / "a.jsonl", tmp_path / "logs.duckdb"
    src.write_text(LOG, encoding="utf-8")
    access_logs.import_access_logs(str(src), str(duck_path), "jsonl")
    return access_logs.analyze_access_logs(str(duck_path))


def test_latency_is_reported_as_percentiles(metrics):
    lat = metrics["latency"]
    assert lat is not None and lat["measured_requests"] == 420
    # The mean would hide the 5 s tail behind 120 fast requests.
    assert lat["p50_ms"] < 200 and lat["p99_ms"] >= 1000


def test_egress_is_totalled_and_attributed(metrics):
    eg = metrics["egress"]
    assert eg["total_bytes"] == 300 * 10_000_000 + 60 * 900
    top = eg["top_keys_by_bytes"][0]
    # "which key is the bill" is the actionable half.
    assert top["value"] == "video/big.mp4"


def test_errors_are_attributed_to_a_prefix(metrics):
    rows = {r["value"]: r for r in metrics["errors_by_prefix"]}
    assert "thumbs/" in rows
    assert rows["thumbs/"]["errors_4xx"] == 60


def test_error_rate_is_reported_over_time(metrics):
    hours = metrics["errors_by_hour"]
    assert hours and all("error_rate" in h for h in hours)
    assert sum(h["errors"] for h in hours) == 60


def test_top_talkers_use_the_masked_ip(metrics):
    clients = {c["value"]: c for c in metrics["top_clients"]}
    # The IP was masked at ingest (rule 15) and nothing here may restore it: the
    # last octet is gone, which is enough to tell "one caller" from "everyone".
    assert "10.0.0.x" in clients
    assert clients["10.0.0.x"]["requests"] == 420
    assert not any(str(v).endswith((".7", ".8", ".9")) for v in clients)


def test_findings_name_the_failing_prefix(metrics):
    titles = [f["title"] for f in access_logs.derive_findings(metrics)]
    assert "Errors concentrated in one prefix" in titles


def test_a_log_without_timing_reports_absence_not_zero(tmp_path):
    plain = "\n".join(
        '{"timestamp": "2026-08-05T01:00:00Z", "method": "GET", "key": "a", "status_code": 200}'
        for _ in range(60)
    )
    src, duck_path = tmp_path / "b.jsonl", tmp_path / "b.duckdb"
    src.write_text(plain, encoding="utf-8")
    access_logs.import_access_logs(str(src), str(duck_path), "jsonl")
    m = access_logs.analyze_access_logs(str(duck_path))
    # A "p95 = 0 ms" would be a false claim about performance.
    assert m["latency"] is None
    assert m["egress"] is None
    # And no timing finding may be invented from it.
    titles = [f["title"] for f in access_logs.derive_findings(m)]
    assert "Long latency tail" not in titles and "Slow median request" not in titles
