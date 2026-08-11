"""v0.76.0 — every read-only tool, against every way a real endpoint misbehaves.

This is the generalization of v0.74.0. That release fixed three defects found by
pointing the real client at a real socket for one afternoon; all three lived in
code with substantial unit coverage, because every existing test feeds a CODED
error through a Stubber — the one shape that cannot expose a missing HTTP-status
fallback, a dead guard, or an empty error report.

So the check here is not per-tool expectations. It is a MATRIX — every tool ×
every hostile shape — asserting invariants that hold for all of them:

| # | invariant |
| --- | --- |
| I1 | a tool never raises; a failure is a returned shape |
| I2 | a failure names its cause — an empty `error_code` AND empty message is not a report |
| I3 | a failure never leaves a determined verdict standing (the v0.74.0 "cleanly deletable" bug) |
| I4 | nothing ever echoes a credential, on any path |
| I5 | a capability gap (501/405) is never reported as a *successful* positive finding |

A tool added later inherits all of it without anyone remembering to add it,
which is the point: this exists so that the CLASS of defect cannot come back,
not so that today's five instances stay fixed.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Callable

import pytest

from app import config
from app.s3 import config_tools as ct
from app.s3 import tools as s3
from tests.fake_endpoint import ALL_BEHAVIOURS, CAPABILITY_GAPS, FakeEndpoint

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
TOKEN = "FwoGZXIvYXdzEXAMPLEsessiontoken"
B, K = "bucket-alpha", "logs/2026/08/11/object.json.gz"


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def _provider(client, endpoint: str, name: str) -> str:
    return client.post("/cloud-providers", json={
        "name": name,
        "provider_type": "s3-compatible",
        "endpoint_url": endpoint,
        "region": "us-east-1",
        "addressing_style": "path",
        "access_key": ACCESS,
        "secret_key": SECRET,
        "session_token": TOKEN,
        "mode": "readonly",
    }).json()["id"]


#: Every read-only tool that talks to an endpoint, with arguments that are valid
#: in themselves — so anything that goes wrong is the ENDPOINT's doing, which is
#: exactly what the matrix is about.
TOOLS: dict[str, Callable[[sqlite3.Connection, str], dict[str, Any]]] = {
    "test_credentials": lambda c, p: s3.test_credentials(c, p),
    "list_buckets": lambda c, p: s3.list_buckets(c, p),
    "head_bucket": lambda c, p: s3.head_bucket(c, p, B),
    "get_bucket_location": lambda c, p: s3.get_bucket_location(c, p, B),
    "list_objects_v2": lambda c, p: s3.list_objects_v2(c, p, B, 10),
    "list_object_versions": lambda c, p: s3.list_object_versions(c, p, B, max_keys=10),
    "list_multipart_uploads": lambda c, p: s3.list_multipart_uploads(c, p, B, max_uploads=10),
    "list_upload_parts": lambda c, p: s3.list_upload_parts(c, p, B, K, "upload-id", 10),
    "head_object": lambda c, p: s3.head_object(c, p, B, K),
    "test_range_get": lambda c, p: s3.test_range_get(c, p, B, K, "bytes=0-127"),
    "test_conditional_get": lambda c, p: s3.test_conditional_get(c, p, B, K, '"etag"'),
    "preview_object": lambda c, p: s3.preview_object(c, p, B, K),
    "get_object_lock_status": lambda c, p: s3.get_object_lock_status(c, p, B, K),
    "get_object_acl": lambda c, p: s3.get_object_acl(c, p, B, K),
    "get_object_tagging": lambda c, p: s3.get_object_tagging(c, p, B, K),
    "get_object_attributes": lambda c, p: s3.get_object_attributes(c, p, B, K),
    "measure_request_latency": lambda c, p: s3.measure_request_latency(c, p, B, None, 2),
    "get_bucket_config_summary": lambda c, p: ct.get_bucket_config_summary(c, p, B),
}

#: Values that assert something POSITIVE about the target: "there is no
#: retention", "it is not configured", "it is available". After a failure the
#: tool learned none of that, and saying it anyway is how v0.74.0 told someone
#: asking *why can't I delete this object?* that it was cleanly deletable.
DETERMINED: frozenset[str] = frozenset({
    "none", "not_configured", "available", "disabled", "off", "absent", "clean",
})

#: Fields that carry a verdict about the target rather than about the call.
def _verdict_fields(result: dict[str, Any]) -> dict[str, Any]:
    return {
        k: v for k, v in result.items()
        if (k.endswith("_status") or k.endswith("_enabled") or k in ("verdict", "is_public"))
        # `status` on the CALL (available / error / provider_unsupported) is a
        # report about reachability, not a claim about the bucket's config.
        and k not in ("status", "head_bucket_status")
    }


@pytest.fixture(autouse=True)
def _no_retries(monkeypatch):
    """One attempt per call.

    Two of the shapes — a connection reset and a 500 — are RETRYABLE, so each
    call pays a retry plus standard-mode backoff. Across 18 tools x 7 shapes,
    with `get_bucket_config_summary` alone making ~20 sub-resource calls, that
    turns a seconds-long suite into a minutes-long one while testing nothing
    extra: these invariants are about the shape a tool RETURNS, not about how
    many times it asked.

    Patched on `client_factory._MAX_ATTEMPTS`, NOT via `AWS_MAX_ATTEMPTS` —
    which was tried first and does nothing here, because the factory passes an
    explicit `retries={"max_attempts": …}` in its botocore `Config` and an
    explicit Config beats the environment.
    """
    from app.s3 import client_factory

    monkeypatch.setattr(client_factory, "_MAX_ATTEMPTS", 1)


@pytest.fixture(scope="module")
def endpoints():
    servers = {b: FakeEndpoint(b).__enter__() for b in ALL_BEHAVIOURS}
    yield servers
    for s in servers.values():
        s.__exit__()


@pytest.mark.parametrize("behaviour", ALL_BEHAVIOURS)
@pytest.mark.parametrize("tool", sorted(TOOLS))
def test_endpoint_matrix(client, endpoints, behaviour, tool):
    ep = endpoints[behaviour]
    pid = _provider(client, ep.endpoint_url, f"{tool}-{behaviour}")
    conn = _db()

    # I1 — a tool never raises. A traceback out of a tool becomes an opaque
    # turn failure with no trace row and nothing the agent can say.
    try:
        res = TOOLS[tool](conn, pid)
    except Exception as exc:  # noqa: BLE001
        pytest.fail(f"{tool} raised {type(exc).__name__} on {behaviour}: {exc}")

    assert isinstance(res, dict), f"{tool} returned {type(res).__name__}"
    blob = json.dumps(res, default=str)

    # I4 — no credential ever appears in a tool result, on any path. The error
    # paths are the ones that carry raw provider text, so they are where a
    # signature or an Authorization header would leak.
    for secret, label in ((ACCESS, "access key"), (SECRET, "secret key"), (TOKEN, "session token")):
        assert secret not in blob, f"{tool} leaked the {label} on {behaviour}"

    if res.get("success") is False:
        # I2 — a failure that says nothing is not a report. At least one of the
        # three identifying fields has to carry something.
        named = (
            (res.get("error_code") or "").strip()
            or (res.get("error_message_sanitized") or "").strip()
            or res.get("status_code") is not None
        )
        assert named, f"{tool} failed on {behaviour} with nothing to say: {blob}"

        # I3 — no determined verdict may survive a failure.
        for field, value in _verdict_fields(res).items():
            if isinstance(value, str):
                assert value.lower() not in DETERMINED, (
                    f"{tool} failed on {behaviour} but still claims {field}={value!r} — "
                    f"a verdict about a target it never reached: {blob}"
                )
            elif value is True:
                pytest.fail(
                    f"{tool} failed on {behaviour} but still claims {field} is True: {blob}"
                )

    # I5 — a capability gap must not be dressed up as a positive finding. It may
    # be reported as a gap, or as a failure; it may not be reported as a
    # SUCCESSFUL determination about the target.
    if behaviour in CAPABILITY_GAPS and res.get("success") is True:
        for field, value in _verdict_fields(res).items():
            if isinstance(value, str) and value.lower() in DETERMINED:
                pytest.fail(
                    f"{tool} turned a {behaviour} capability gap into {field}={value!r} — "
                    f"a determined verdict from an endpoint that answered nothing: {blob}"
                )


def test_the_matrix_actually_covers_the_tools():
    """A matrix that silently stops covering a tool is worse than no matrix.

    Pinned against the agent's own gated-tool table so that adding a tool to a
    group without adding it here is a test failure rather than a silent hole.
    """
    from app.agent_runtime.session_agent import _TOOL_GROUPS

    live_groups = ("object_forensics", "storage_pileup")
    expected = {t for g in live_groups for t in _TOOL_GROUPS[g][1]}
    # These two are covered but named differently at the S3 layer, and
    # `diagnose_presigned_url` / `inspect_endpoint_tls` make no S3 call at all.
    covered = set(TOOLS)
    missing = expected - covered
    assert not missing, (
        f"tools in {live_groups} with no row in the endpoint matrix: {sorted(missing)}"
    )


def test_every_behaviour_is_exercised():
    """The fixture's shapes are the point; an unused one is a gap pretending to
    be coverage."""
    assert set(ALL_BEHAVIOURS) >= CAPABILITY_GAPS
    assert len(ALL_BEHAVIOURS) >= 7
