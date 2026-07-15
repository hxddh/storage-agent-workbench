"""Deterministic parser for pasted S3 / object-storage errors.

Extracts structured signals from an ALREADY-REDACTED error blob. It never calls
an LLM or S3; it only pattern-matches. Uncertainty is preserved — unknown fields
are left null and a coarse ``input_kind``/``detected`` view is returned. The full
raw blob is NOT part of the parser output handed to the Agent (only these
bounded signals are).
"""

from __future__ import annotations

import re
from typing import Any

from ..security.redaction import redact_text

# Triage-local extra redaction: scrub SigV4 Authorization-header remnants and
# cookies that the generic free-text redactor (which targets ?query= params)
# may not catch. Applied on top of redact_text.
_EXTRA_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)\b(signature|credential)=([^\s,&]+)"), r"\1=***REDACTED***"),
    (re.compile(r"(?i)(cookie\s*[:=]\s*)(\S+)"), r"\1***REDACTED***"),
    # secret access key / session token / API key in key=value or key: value form
    (re.compile(
        r"(?i)\b(aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|"
        r"aws[_-]?session[_-]?token|session[_-]?token|x-amz-security-token|security[_-]?token|"
        r"api[_-]?key)\b\s*[:=]\s*\S+"),
        r"\1=***REDACTED***"),
    # OpenAI-style model keys
    (re.compile(r"\bsk-[A-Za-z0-9][A-Za-z0-9_\-]{5,}\b"), "***REDACTED***"),
]

MAX_INPUT_CHARS = 20000  # bound persisted/redacted input


def redact_input(text: str) -> str:
    """Redact an error blob: shared redactor + triage-local extras + length cap."""
    out = redact_text(text or "")
    for pattern, repl in _EXTRA_PATTERNS:
        out = pattern.sub(repl, out)
    return out[:MAX_INPUT_CHARS]


# Known S3 / S3-compatible error codes we recognize (kept small + targeted; this
# is NOT an exhaustive error-code dictionary).
KNOWN_ERROR_CODES = {
    "SignatureDoesNotMatch", "AccessDenied", "InvalidAccessKeyId", "NoSuchBucket",
    "NoSuchKey", "PermanentRedirect", "RequestTimeTooSkewed", "SlowDown",
    "TooManyRequests", "RequestTimeout", "BadGateway", "InternalError", "InvalidPart",
    "EntityTooSmall", "PreconditionFailed", "InvalidBucketName",
    "AuthorizationHeaderMalformed", "ServiceUnavailable", "Throttling",
    # v0.29.0: archived-object GETs, KMS-encrypted-object denials (note the DOTS —
    # the regexes below must accept them), STS credential expiry, and the
    # capability-gap codes S3-compatible providers return for unimplemented APIs.
    "InvalidObjectState", "KMS.AccessDenied", "KMS.DisabledException",
    "KMS.NotFoundException", "ExpiredToken", "InvalidToken",
    "NotImplemented", "MethodNotAllowed",
}

_CODE_RE = re.compile(r"<Code>\s*([A-Za-z][A-Za-z.]{0,39})\s*</Code>")
_CODE_KV_RE = re.compile(r"(?i)\b(?:error\s*code|errorcode|code)\s*[:=]\s*['\"]?([A-Za-z][A-Za-z.]{3,39})")
_HTTP_RE = re.compile(r"(?i)(?:HTTP/\d\.\d\s+|status(?:\s*code)?\s*[:=]\s*)(\d{3})")
_REQUEST_ID_RE = re.compile(r"(?i)<RequestId>\s*([^<\s]+)\s*</RequestId>|\brequest[\s_-]?id['\"]?\s*[:=]\s*['\"]?([A-Za-z0-9\-]+)")
_HOST_ID_RE = re.compile(r"(?i)<HostId>\s*([^<\s]+)\s*</HostId>|\bhost[\s_-]?id['\"]?\s*[:=]\s*['\"]?([A-Za-z0-9+/=_\-]+)")
_REGION_RE = re.compile(r"(?i)\b(?:region|x-amz-bucket-region|expecting\s+'?)\s*[:=]?\s*['\"]?((?:[a-z]{2}-[a-z]+-\d)|[a-z]{2}-[a-z]+\d?)")
_ENDPOINT_RE = re.compile(r"(?i)\b((?:https?://)?[a-z0-9.\-]+\.(?:amazonaws\.com|aliyuncs\.com|myqcloud\.com|example\.com|[a-z0-9.\-]+)(?::\d+)?)")
_BUCKET_RE = re.compile(r"(?i)<BucketName>\s*([^<\s]+)\s*</BucketName>|\bbucket['\"]?\s*[:=]\s*['\"]?([A-Za-z0-9.\-_]+)")
_METHOD_RE = re.compile(r"\b(GET|PUT|POST|DELETE|HEAD|OPTIONS)\b")
_OPERATION_RE = re.compile(r"(?i)\b(ListObjectsV2|ListObjects|GetObject|PutObject|HeadObject|HeadBucket|CreateMultipartUpload|UploadPart|CompleteMultipartUpload|ListBuckets|GetBucketLocation|DeleteObject)\b")
_TIMESTAMP_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)")
_LANG_HINTS = {
    "python": re.compile(r"(?i)\b(traceback \(most recent call last\)|botocore\.|boto3|\.py\")"),
    "java": re.compile(r"(?i)\b(com\.amazonaws|software\.amazon\.awssdk|\.java:\d+|at\s+[a-z0-9_.]+\([A-Za-z0-9_]+\.java)"),
    "go": re.compile(r"(?i)\b(aws-sdk-go|\.go:\d+|panic:)"),
    "javascript": re.compile(r"(?i)\b(@aws-sdk/|aws-sdk\b|\.js:\d+|at\s+Object\.<anonymous>)"),
    "cli": re.compile(r"(?i)\b(aws s3|aws s3api|aws-cli|An error occurred \()"),
}
_TLS_RE = re.compile(r"(?i)(tls|ssl|certificate|x509|handshake|cert(ificate)? verify)")
_CONN_RE = re.compile(r"(?i)(connection reset|connection refused|timed out|timeout|broken pipe|EOF|no route to host|dial tcp)")


def _first(*groups: Any) -> str | None:
    for g in groups:
        if g:
            return str(g).strip()
    return None


def parse(redacted: str, input_kind: str = "mixed") -> dict[str, Any]:
    """Parse a REDACTED error blob into bounded, sanitized signals."""
    text = redacted or ""

    code = None
    m = _CODE_RE.search(text)
    if m:
        code = m.group(1)
    if not code:
        m = _CODE_KV_RE.search(text)
        if m and m.group(1) in KNOWN_ERROR_CODES:
            code = m.group(1)
    if not code:
        # Bare token match for known codes anywhere in the text. Longest first,
        # deterministically: "KMS.AccessDenied" must win over its embedded
        # "AccessDenied" (the dot is a word boundary, so both would match).
        for known in sorted(KNOWN_ERROR_CODES, key=len, reverse=True):
            if re.search(rf"\b{re.escape(known)}\b", text):
                code = known
                break

    http_status = None
    m = _HTTP_RE.search(text)
    if m:
        try:
            http_status = int(m.group(1))
        except ValueError:
            http_status = None

    region = None
    m = _REGION_RE.search(text)
    if m:
        region = m.group(1)

    endpoint = None
    m = _ENDPOINT_RE.search(text)
    if m:
        endpoint = m.group(1)

    bucket = None
    m = _BUCKET_RE.search(text)
    if m:
        bucket = _first(m.group(1), m.group(2))

    request_id = None
    m = _REQUEST_ID_RE.search(text)
    if m:
        request_id = _first(m.group(1), m.group(2))
    host_id = None
    m = _HOST_ID_RE.search(text)
    if m:
        host_id = _first(m.group(1), m.group(2))

    method = None
    m = _METHOD_RE.search(text)
    if m:
        method = m.group(1)
    operation = None
    m = _OPERATION_RE.search(text)
    if m:
        operation = m.group(1)
    timestamp = None
    m = _TIMESTAMP_RE.search(text)
    if m:
        timestamp = m.group(1)

    language = None
    for lang, rx in _LANG_HINTS.items():
        if rx.search(text):
            language = lang
            break

    flags = {
        "tls_or_cert": bool(_TLS_RE.search(text)),
        "connection_error": bool(_CONN_RE.search(text)),
        "path_style_hint": bool(re.search(r"(?i)path[\s-]?style|virtual[\s-]?host", text)),
        "pagination_hint": bool(re.search(r"(?i)continuation[\s-]?token|IsTruncated|NextContinuationToken", text)),
        "multipart_hint": bool(re.search(r"(?i)multipart|UploadPart|part\s*number", text)),
        "clock_skew_hint": bool(re.search(r"(?i)RequestTimeTooSkewed|time.*skew|clock", text)),
    }

    return {
        "input_kind": input_kind,
        "error_code": code,
        "http_status": http_status,
        "region": region,
        "endpoint": endpoint,
        "bucket": bucket,
        "request_id": request_id,
        "host_id": host_id,
        "method": method,
        "operation": operation,
        "timestamp": timestamp,
        "language": language,
        "flags": flags,
        "recognized": bool(code or http_status or flags["tls_or_cert"] or flags["connection_error"]),
    }
