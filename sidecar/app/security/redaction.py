"""Redaction utility.

Removes secrets before anything is logged, persisted, or returned. Used for
audit-log payloads and any free-form text that might contain credentials.

Two layers:

1. Key-name based: dict keys that look like secrets have their values masked.
2. Value/pattern based: strings are scrubbed of known credential shapes
   (AWS keys, bearer/authorization values, presigned-URL query parameters).

``keyring://`` references are intentionally NOT redacted — they are safe
pointers, not secrets.
"""

from __future__ import annotations

import re
from typing import Any

REDACTED = "***REDACTED***"

# Dict keys (case-insensitive, non-alphanumeric stripped) whose values are secrets.
_SENSITIVE_KEYS = {
    "apikey",
    "accesskey",
    "accesskeyid",
    "secretkey",
    "secretaccesskey",
    "secret",
    "sessiontoken",
    "securitytoken",
    "token",
    "password",
    "passwd",
    "authorization",
    "auth",
    "cookie",
    "setcookie",
    "signature",
    "bearer",
    # request-body field names used by this app's provider APIs
    "session_token",
    # HTTP / S3 header names that may carry credentials
    "xamzsecuritytoken",
    "xamzcredential",
    "wwwauthenticate",
    "proxyauthorization",
    "credential",
}

_KEY_NORMALIZE = re.compile(r"[^a-z0-9]")

# Value patterns. Each replaces the secret portion with REDACTED.
_VALUE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # AWS access key IDs (AKIA/ASIA/AGPA/AIDA... + 16 base32 chars)
    (re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b"), REDACTED),
    # Authorization / Bearer header values
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]+"), r"\1 " + REDACTED),
    (
        re.compile(r"(?i)(authorization\s*[:=]\s*)(\S+)"),
        r"\1" + REDACTED,
    ),
    # Presigned-URL / SigV4 query parameters
    (
        re.compile(
            r"(?i)([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|"
            r"Signature|AWSAccessKeyId|X-Amz-SignedHeaders)=)([^&\s]+)"
        ),
        r"\1" + REDACTED,
    ),
]


def _is_sensitive_key(key: str) -> bool:
    return _KEY_NORMALIZE.sub("", key.lower()) in _SENSITIVE_KEYS


def redact_text(text: str) -> str:
    """Scrub credential-shaped substrings from a string."""
    out = text
    for pattern, repl in _VALUE_PATTERNS:
        out = pattern.sub(repl, out)
    return out


def mask_ip(ip: str | None) -> str | None:
    """Mask the host portion of an IP address.

    ``192.0.2.10`` -> ``192.0.2.x``; ``2001:db8::1`` -> ``2001:db8::x``.
    Returns the input unchanged-ish (``masked``) if it is not parseable.
    """
    if not ip:
        return ip
    ip = ip.strip()
    if "." in ip:  # IPv4
        parts = ip.split(".")
        if len(parts) == 4 and all(p.isdigit() for p in parts):
            return ".".join(parts[:3] + ["x"])
        return "masked"
    if ":" in ip:  # IPv6
        head, _, _ = ip.rpartition(":")
        return f"{head}:x" if head else "::x"
    return "masked"


def redact(value: Any) -> Any:
    """Recursively redact a JSON-like structure.

    - Dict values under sensitive key names are masked (unless they are
      ``keyring://`` references, which are safe).
    - All strings are run through :func:`redact_text`.
    """
    if isinstance(value, dict):
        result: dict[Any, Any] = {}
        for k, v in value.items():
            if isinstance(k, str) and _is_sensitive_key(k):
                if isinstance(v, str) and v.startswith("keyring://"):
                    result[k] = v
                elif v is None:
                    result[k] = None
                else:
                    result[k] = REDACTED
            else:
                result[k] = redact(v)
        return result
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    return value
