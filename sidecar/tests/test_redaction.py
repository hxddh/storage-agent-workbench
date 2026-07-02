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


def test_redacts_labeled_aws_secret_access_key_in_text():
    secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"  # 40-char AWS secret
    for line in (
        f"aws_secret_access_key={secret}",
        f"AWS_SECRET_ACCESS_KEY={secret}",
        f"secret_access_key: {secret}",
        f'secret_key = "{secret}"',
    ):
        out = redact_text(line)
        assert secret not in out, line
        assert REDACTED in out


def test_redacts_labeled_session_token_in_text():
    tok = "FwoGZXIvYXdzEExampleSessionTokenValue12345"
    for line in (
        f"aws_session_token={tok}",
        f"AWS_SESSION_TOKEN={tok}",
        f"x-amz-security-token: {tok}",
    ):
        out = redact_text(line)
        assert tok not in out, line
        assert REDACTED in out


def test_does_not_over_redact_ordinary_bucket_names_or_prose():
    # No secret-ish label → the new labeled/40-char rules mask nothing. A long
    # object key and ordinary prose (including a bare 40-char token) survive.
    text = (
        "bucket analytics-prod holds "
        "report-2026-01-01-final-quarterly-summary-archived.csv and the "
        "commit is 1234567890abcdef1234567890abcdef12345678"
    )
    assert redact_text(text) == text


def test_redacts_cookie_header_text():
    out = redact_text("Cookie: sessionid=abc123secret; theme=dark")
    assert "abc123secret" not in out
    assert REDACTED in out
    out2 = redact_text("Set-Cookie: token=deadbeefdeadbeef; Path=/; HttpOnly")
    assert "deadbeefdeadbeef" not in out2
    assert REDACTED in out2
    # Prose that merely mentions "cookie" (no key=value) is left intact.
    assert redact_text("the cookie jar was empty") == "the cookie jar was empty"


def test_redacts_bare_signature_not_in_query_context():
    out = redact_text("computed Signature=deadbeefcafef00d for the request")
    assert "deadbeefcafef00d" not in out
    assert "Signature=" + REDACTED in out


def test_redacts_third_party_tokens():
    # Tokens are assembled from parts so no contiguous secret-shaped literal
    # lives in the source (keeps push-protection/secret-scanners quiet). These
    # are synthetic and match only the redaction regexes, not any real service.
    samples = [
        "ghp_" + "A" * 36,
        "gho_" + "b" * 36,
        "ghs_" + "c" * 36,
        "ghr_" + "d" * 36,
        "github_pat_" + "e" * 30,
        "xoxb-" + "1" * 12 + "-" + "A" * 20,
        "xoxp-" + "2" * 10 + "-" + "3" * 10 + "-" + "z" * 12,
        "AIza" + "Z" * 35,
    ]
    for token in samples:
        out = redact_text(f"leaked token {token} here")
        assert token not in out, token
        assert REDACTED in out


def test_redacts_jwt():
    jwt = (
        "eyJhbGciOiJIUzI1NiJ9"
        ".eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJib2IifQ"
        ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    )
    out = redact_text(f"authorization token {jwt} received")
    assert jwt not in out
    assert REDACTED in out


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
