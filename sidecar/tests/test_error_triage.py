"""Tests for error triage (deterministic parser + playbooks).

All inputs are SYNTHETIC (example.com endpoints, fake buckets, fake ids) — no
real customer/endpoint/credential data (public repo). Triage is the offline,
deterministic path (no LLM narrator): these verify parsing,
redaction-before-persist, playbook causes/next-checks, proposals-only next
actions, session binding + summary refresh, and that triage performs no S3
call / no run creation / no evidence download.
"""

import sqlite3

import pytest

from app import config, run_service
from app.error_triage import engine, parser
from app.s3 import client_factory

ACCESS = "AKIAIOSFODNN7EXAMPLE"
MODEL_KEY = "sk-MODELSECRETDONOTLEAK1234"

SIG_ERROR = (
    '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code>'
    "<Message>The request signature we calculated does not match.</Message>"
    "<RequestId>FAKEREQ123</RequestId><HostId>fakehost==</HostId></Error>\n"
    "Authorization: AWS4-HMAC-SHA256 Credential=" + ACCESS + "/20260101/us-east-1/s3/aws4_request, "
    "SignedHeaders=host, Signature=deadbeefdeadbeefdeadbeef\n"
    "endpoint: https://s3.example.com region: us-east-1\n"
    "Cookie: session=topsecretcookievalue\n"
    "presigned: https://s3.example.com/b/k?X-Amz-Signature=abc123sig&X-Amz-Credential=" + ACCESS
)
ACCESS_DENIED = "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error> HTTP/1.1 403"
REDIRECT = ("<Error><Code>PermanentRedirect</Code><Message>The bucket is in this region: us-west-2.</Message>"
            "<BucketName>example-bucket</BucketName></Error> region: us-west-2")
SLOWDOWN = "<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error> status: 503"
SERVER_502 = "HTTP/1.1 502 Bad Gateway\nconnection reset by peer while reading from upstream"


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


def _session(client, **kw):
    return client.post("/sessions", json={"title": "Triage", "goal": "diagnose", **kw}).json()


def _add_model_provider(client):
    client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": MODEL_KEY})


def _triage(client, content, **kw):
    return client.post("/error-triage", json={"content": content, "input_kind": "mixed", **kw})


# --- parser -----------------------------------------------------------------


def test_parse_signature_does_not_match():
    p = parser.parse(parser.redact_input(SIG_ERROR))
    assert p["error_code"] == "SignatureDoesNotMatch"
    assert p["region"] == "us-east-1"


def test_parse_access_denied():
    p = parser.parse(parser.redact_input(ACCESS_DENIED))
    assert p["error_code"] == "AccessDenied" and p["http_status"] == 403


def test_parse_permanent_redirect():
    p = parser.parse(parser.redact_input(REDIRECT))
    assert p["error_code"] == "PermanentRedirect" and p["region"] == "us-west-2"


def test_parse_slowdown():
    p = parser.parse(parser.redact_input(SLOWDOWN))
    assert p["error_code"] == "SlowDown"


def test_parse_502_and_connection():
    p = parser.parse(parser.redact_input(SERVER_502))
    assert p["http_status"] == 502 and p["flags"]["connection_error"] is True


def test_redacts_authorization_cookies_presigned():
    red = parser.redact_input(SIG_ERROR)
    assert ACCESS not in red
    assert "deadbeefdeadbeef" not in red       # Signature=
    assert "abc123sig" not in red               # presigned X-Amz-Signature
    assert "topsecretcookievalue" not in red    # Cookie value


def test_redacts_ak_sk_session_token_api_key():
    blob = (f"aws_access_key_id={ACCESS}\naws_secret_access_key=AbCdEf1234567890SECRETkeyvalue+/\n"
            f"aws_session_token=FwoGZXIvYXdzSESSIONTOKEN\napi_key={MODEL_KEY}")
    red = parser.redact_input(blob)
    assert ACCESS not in red
    assert "SECRETkeyvalue" not in red
    assert "FwoGZXIvYXdzSESSIONTOKEN" not in red
    assert "MODELSECRETDONOTLEAK" not in red


# --- engine / playbooks -----------------------------------------------------


def test_triage_signature_causes_and_next_checks():
    r = engine.analyze(parser.redact_input(SIG_ERROR))
    titles = " ".join(c["title"] for c in r["candidate_causes"]).lower()
    assert "signature" in titles
    checks = " ".join(" ".join(c["next_checks"]) for c in r["candidate_causes"]).lower()
    assert "test_credentials" in checks or "path-style" in checks or "region" in checks


def test_triage_access_denied_causes():
    r = engine.analyze(parser.redact_input(ACCESS_DENIED))
    cats = {c["category"] for c in r["candidate_causes"]}
    assert "authz" in cats
    assert any(a["action_type"] == "run_bucket_config_review" for a in r["safe_next_actions"])
    # Bridge: an authz error points at the security-iam-policy specialist skill.
    assert "storageops-security-iam-policy" in r["suggested_skills"]


def test_triage_next_checks_use_real_tool_names():
    """next_checks must reference tools the agent actually has — not the stale
    get_bucket_location (report 2.6); get_bucket_config_summary reads location."""
    from app.error_triage import playbooks
    for entry in playbooks._BY_CODE.values():
        joined = " ".join(entry["next_checks"])
        assert "get_bucket_location" not in joined, entry["code"]


def test_triage_region_mismatch_suggests_diagnostic():
    r = engine.analyze(parser.redact_input(REDIRECT))
    assert any(a["action_type"] == "run_diagnostic" for a in r["safe_next_actions"])


def test_triage_429_suggests_access_log_import():
    r = engine.analyze(parser.redact_input(SLOWDOWN))
    assert any(a["action_type"] == "plan_access_log_import" for a in r["safe_next_actions"])


def test_next_actions_are_proposals_only():
    r = engine.analyze(parser.redact_input(SIG_ERROR))
    for a in r["safe_next_actions"]:
        assert a["requires_confirmation"] is True
        assert a["action_type"] in {
            "run_account_discovery", "run_bucket_config_review", "run_diagnostic",
            "plan_inventory_import", "plan_access_log_import", "run_inventory_analysis",
            "run_access_log_analysis", "generate_session_report", "ask_user_for_context"}


# --- API + persistence ------------------------------------------------------


def test_triage_stores_redacted_input_only(client):
    out = _triage(client, SIG_ERROR).json()
    case = client.get(f"/error-triage/{out['id']}").json()
    assert ACCESS not in case["raw_input_redacted"]
    assert "deadbeefdeadbeef" not in case["raw_input_redacted"]
    # parsed signals carry no secret either
    import json as _json
    assert ACCESS not in _json.dumps(case["parsed"])


def test_triage_proposals_survive_reload(client):
    """safe_next_actions aren't persisted, but GET + the session list re-derive
    them deterministically so the clickable next-step chips survive a reload /
    session-switch (the POST response is no longer the only place they appear)."""
    s = _session(client)
    posted = _triage(client, SIG_ERROR, session_id=s["id"]).json()
    assert posted["safe_next_actions"], "POST should carry proposals"

    got = client.get(f"/error-triage/{posted['id']}").json()
    listed = client.get(f"/sessions/{s['id']}/error-triage").json()["cases"]
    case = next(c for c in listed if c["id"] == posted["id"])

    types = lambda acts: sorted(a["action_type"] for a in acts)  # noqa: E731
    assert got["safe_next_actions"] and case["safe_next_actions"]
    assert types(got["safe_next_actions"]) == types(posted["safe_next_actions"])
    assert types(case["safe_next_actions"]) == types(posted["safe_next_actions"])


def test_triage_binds_to_session_and_refreshes_summary(client):
    s = _session(client)
    out = _triage(client, SIG_ERROR, session_id=s["id"]).json()
    assert out["session_id"] == s["id"]
    listed = client.get(f"/sessions/{s['id']}/error-triage").json()["cases"]
    assert any(c["id"] == out["id"] for c in listed)
    summary = client.get(f"/sessions/{s['id']}/summary").json()
    assert any("Error triage" in str(f.get("text", "")) for f in summary["known_facts"])


def test_triage_is_deterministic_only(client):
    out = _triage(client, ACCESS_DENIED).json()
    # No LLM narrator: the response carries no agent/planner fields.
    assert "planner_mode" not in out and "agent_interpretation" not in out
    assert out["candidate_causes"]  # deterministic playbook matched


def test_triage_does_not_create_run_or_download(client):
    before = len(client.get("/runs").json())
    _triage(client, SIG_ERROR)
    after = len(client.get("/runs").json())
    conn = _db()
    try:
        imports = conn.execute("SELECT count(*) FROM evidence_imports").fetchone()[0]
        datasets = conn.execute("SELECT count(*) FROM datasets").fetchone()[0]
    finally:
        conn.close()
    assert after == before and imports == 0 and datasets == 0


def test_triage_does_not_call_s3(client, monkeypatch):
    def _boom(*a, **k):
        raise AssertionError("error triage must not call S3")
    monkeypatch.setattr(client_factory, "build_s3_client", _boom)
    out = _triage(client, SIG_ERROR)
    assert out.status_code == 200  # triage completed without ever building an S3 client


# --- report + safety --------------------------------------------------------


def test_session_report_includes_triage_without_raw_input(client):
    s = _session(client)
    _triage(client, SIG_ERROR, session_id=s["id"])
    report = client.get(f"/sessions/{s['id']}/report").json()["content"]
    assert "## Error triage" in report
    assert "SignatureDoesNotMatch" in report
    assert ACCESS not in report and "deadbeefdeadbeef" not in report


def test_existing_run_apis_unaffected(client, monkeypatch):
    monkeypatch.setattr(run_service, "start", run_service.run_sync)
    created = client.post("/runs", json={"run_type": "access_log_analysis", "user_prompt": "x"}).json()
    rid = created["run_id"]
    log = '2026-01-01T00:00:00Z b GET /p 200 10 5 ms user-agent="x" remote_ip="192.0.2.10"\n'
    client.post(f"/runs/{rid}/datasets/upload",
                files={"file": ("a.log", log.encode(), "text/plain")}, data={"dataset_type": "access_log"})
    client.post(f"/runs/{rid}/message", json={"content": "go"})
    assert client.get(f"/runs/{rid}").json()["status"] == "completed"
