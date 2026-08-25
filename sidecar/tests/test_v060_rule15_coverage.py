"""v0.60.0 — rule 15 becomes a test, not a memory.

`test_redaction.py` has twenty-odd tests and they are good ones, but they are
organised by PATTERN: each covers a shape somebody thought of. Nothing walked
rule 15's list and asserted every category on it was actually covered. So
`?password=` was never redacted — not because anyone judged it safe, but because
no test existed to say otherwise.

Measured before the fix: twelve credential-bearing query-parameter names passed
through `redact_text` untouched — `password`, `passwd`, `pwd`, `secret`,
`client_secret`, `access_token`, `refresh_token`, `credential`, `credentials`,
`auth`, `session`, `sessionid`.

The damaging path was the most ordinary one. An operator pasting a failing URL
from a self-hosted MinIO or Ceph endpoint sends it into the model prompt through
`redact_text`, and there is no second line of defense: `_contains_secret` does
not recognise that shape, and `assert_no_secrets_in_context` guards only the
context block, which the user's message is appended AFTER. That is rule 1 ("never
pass credentials into LLM prompts") as well as rule 15.

This file is table-driven ON PURPOSE. The requirement is the test, so the next
category that drifts fails CI instead of shipping.
"""
from __future__ import annotations

import pytest

from app.security.redaction import redact_text

SECRET = "Zq7SuperSecretValue123456"

# One row per category rule 15 enumerates, with a representative real-world
# carrier for each. If a rule-15 line has no row here, that is the bug.
RULE_15_CATEGORIES: list[tuple[str, str, str]] = [
    ("access keys", "AKIAIOSFODNN7EXAMPLE in the log", "AKIAIOSFODNN7EXAMPLE"),
    ("secret keys",
     "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
     "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    ("session tokens",
     "x-amz-security-token: FQoGZXIvYXdzEBYaDBEXAMPLETOKEN123456",
     "FQoGZXIvYXdzEBYaDBEXAMPLETOKEN123456"),
    ("api keys", "OPENAI_API_KEY=sk-proj-AbCdEf0123456789AbCdEf0123456789",
     "sk-proj-AbCdEf0123456789AbCdEf0123456789"),
    ("authorization headers",
     "Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260806",
     "AKIAIOSFODNN7EXAMPLE"),
    ("signatures",
     "&X-Amz-Signature=1a2b3c4d5e6f70819202122232425262728292a2b2c2d2e2f30313233",
     "1a2b3c4d5e6f70819202122232425262728292a2b2c2d2e2f30313233"),
    ("presigned url credentials",
     "https://b.s3.amazonaws.com/k?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260806",
     "AKIAIOSFODNN7EXAMPLE"),
    ("cookies", "Cookie: session=abc123def456ghi789jkl012mno345",
     "abc123def456ghi789jkl012mno345"),
    ("bearer tokens",
     "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop",
     "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop"),
    ("sensitive query parameters",
     f"https://minio.internal:9000/acme-logs/r.csv?password={SECRET}", SECRET),
]


@pytest.mark.parametrize("category,carrier,secret", RULE_15_CATEGORIES,
                         ids=[c[0] for c in RULE_15_CATEGORIES])
def test_rule_15_category_is_redacted(category: str, carrier: str, secret: str):
    assert secret not in redact_text(carrier), (
        f"rule 15 requires {category!r} to be redacted, and it is not")


# Every credential-bearing query-parameter name measured as leaking in v0.60.0.
# `key` is deliberately absent: in an S3 URL `key=` is the OBJECT key, and
# masking it would destroy the most useful fact in a diagnostic paste.
LEAKING_PARAM_NAMES = [
    "password", "passwd", "pwd", "secret", "client_secret",
    "access_token", "refresh_token", "credential", "credentials",
    "auth", "session", "sessionid",
]


@pytest.mark.parametrize("name", LEAKING_PARAM_NAMES)
def test_credential_query_parameter_is_redacted(name: str):
    assert SECRET not in redact_text(f"https://host/path?{name}={SECRET}&other=1")


@pytest.mark.parametrize("name", LEAKING_PARAM_NAMES)
def test_credential_query_parameter_is_redacted_with_a_vendor_prefix(name: str):
    # `?minio_password=` / `?ceph_access_token=` — S3-compatible vendors prefix
    # their own parameter names, and this product exists for those endpoints.
    assert SECRET not in redact_text(f"https://host/path?minio_{name}={SECRET}&other=1")


@pytest.mark.parametrize("line", [
    "password=hunter2supersecret",
    "client_secret: abc123def456",
    "MINIO_ROOT_PASSWORD=Pr0dR00t99",
    "CEPH_CLIENT_SECRET: abc123def456",
    "ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9.payload",
])
def test_the_same_credentials_pasted_as_a_config_line(line: str):
    """The other half of how these arrive. `MINIO_ROOT_PASSWORD` is the case that
    forced the identifier-prefix form: `\\b` does not match between `_` and
    `PASSWORD`, so the canonical MinIO root-password env var — this product's
    single most likely paste — went straight through."""
    out = redact_text(line)
    assert "***REDACTED***" in out
    # The LABEL survives, so the reader still knows what was masked.
    assert out.split("=")[0].split(":")[0] == line.split("=")[0].split(":")[0]


# Over-redaction is not the safe direction. Masking a bucket name or an object
# key destroys the diagnostic this product exists to produce, so these must be
# left EXACTLY as written.
@pytest.mark.parametrize("text", [
    "The password is wrong — check the vault entry.",
    "AccessDenied: the secret was rotated last week",
    "session expired, please re-authenticate",
    "List s3://acme-logs/?key=year=2026/month=08/report.csv",
    "GET /obj?prefix=logs/&max-keys=1000&continuation-token=abc",
    "bucket named customer-credentials-archive",
    "the auth flow returned 403",
    "next_token=eyJhbGciOiJIUzI1NiJ9",
])
def test_ordinary_diagnostic_text_is_untouched(text: str):
    assert redact_text(text) == text


def test_the_reproduction_that_started_this(  ):
    """The exact paste that reaches the model prompt via `redact_text`."""
    pasted = ("Getting 403 from https://minio.internal:9000/acme-logs/report.csv"
              "?password=Pr0d-M1nio-R00t&access_token=eyJhbGciOiJIUzI1NiJ9.payload.sig")
    out = redact_text(pasted)
    assert "Pr0d-M1nio-R00t" not in out
    assert "eyJhbGciOiJIUzI1NiJ9.payload.sig" not in out
    # The endpoint and the object stay readable — that is the whole diagnostic.
    assert "minio.internal:9000" in out
    assert "acme-logs/report.csv" in out
