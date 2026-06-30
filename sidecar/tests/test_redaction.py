"""Tests for the redaction utility."""

from app.security.redaction import REDACTED, redact, redact_text


def test_redacts_sensitive_dict_keys():
    payload = {
        "name": "prod",
        "api_key": "sk-secret-value-123",
        "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "session_token": "FwoGabcdef",
        "password": "hunter2",
        "authorization": "Bearer abc.def.ghi",
    }
    out = redact(payload)
    assert out["name"] == "prod"
    for key in ("api_key", "access_key", "secret_key", "session_token", "password", "authorization"):
        assert out[key] == REDACTED


def test_keyring_refs_are_preserved():
    payload = {"api_key": "keyring://model_provider/abc/api_key"}
    out = redact(payload)
    assert out["api_key"] == "keyring://model_provider/abc/api_key"


def test_redacts_aws_access_key_in_text():
    text = "found key AKIAIOSFODNN7EXAMPLE in the logs"
    out = redact_text(text)
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert REDACTED in out


def test_redacts_model_api_key_in_text():
    # A user might paste a model key into the chat; it must not survive into
    # persisted messages / audit logs / reports (rule #15).
    for key in ("sk-abcdef0123456789abcdef", "sk-proj-AbC123_def-456ghi"):
        out = redact_text(f"my key is {key} ok")
        assert key not in out
        assert REDACTED in out


def test_does_not_redact_short_sk_prefixed_words():
    # "sk-" alone or a short token is left alone — only key-shaped runs are masked.
    out = redact_text("the task-list and sk-1 marker")
    assert "task-list" in out and "sk-1" in out


def test_redacts_presigned_url_query_params():
    url = (
        "https://s3.example.com/bucket/key?X-Amz-Credential=AKIAEXAMPLE%2Fcred"
        "&X-Amz-Signature=deadbeefdeadbeef&X-Amz-Security-Token=tok123"
    )
    out = redact_text(url)
    assert "deadbeefdeadbeef" not in out
    assert "tok123" not in out
    assert "X-Amz-Signature=" + REDACTED in out


def test_redacts_bearer_token():
    out = redact_text("Authorization: Bearer my-very-secret-token")
    assert "my-very-secret-token" not in out
    assert REDACTED in out


def test_nested_structures():
    payload = {"providers": [{"name": "x", "secret_key": "topsecret"}]}
    out = redact(payload)
    assert out["providers"][0]["secret_key"] == REDACTED
    assert out["providers"][0]["name"] == "x"


def test_redacts_x_amz_credential_query_param():
    url = "https://s3.example.com/b/k?X-Amz-Credential=AKIAEXAMPLE%2F20260625%2Fus-east-1"
    out = redact_text(url)
    assert "AKIAEXAMPLE" not in out
    assert "X-Amz-Credential=" + REDACTED in out


def test_redacts_token_and_security_token_keys():
    payload = {
        "token": "abc.def.ghi",
        "x-amz-security-token": "FwoGsessiontoken",
        "credential": "AKIA/secret/cred",
    }
    out = redact(payload)
    assert out["token"] == REDACTED
    assert out["x-amz-security-token"] == REDACTED
    assert out["credential"] == REDACTED


def test_redacts_header_dict_like_s3_response():
    headers = {
        "content-type": "application/xml",
        "authorization": "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/...",
        "x-amz-security-token": "sessiontoken-value",
    }
    out = redact(headers)
    assert out["content-type"] == "application/xml"
    assert out["authorization"] == REDACTED
    assert out["x-amz-security-token"] == REDACTED
