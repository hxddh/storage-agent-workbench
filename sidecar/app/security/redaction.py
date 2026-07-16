"""Redaction utility.

Removes secrets before anything is logged, persisted, or returned. Used for
audit-log payloads and any free-form text that might contain credentials.

Two layers:

1. Key-name based: dict keys that look like secrets have their values masked.
2. Value/pattern based: strings are scrubbed of known credential shapes
   (AWS access keys, labeled AWS secret keys / session tokens, bearer/
   authorization values, cookies, presigned-URL query parameters — AWS and
   Google-style — bare signatures, bare ``token=`` / ``api_key=`` values,
   common third-party tokens (GitHub, Slack, Google API keys, JWTs), and
   non-AWS provider secrets: GCP PEM ``private_key`` blocks, Azure
   ``AccountKey=`` connection strings, and basic-auth passwords in URLs).

``bytes`` values inside a redacted structure are scrubbed as text too.

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
    # Non-AWS provider secrets (this app targets S3-compatible incl. GCS/Azure):
    # GCP service-account private key, Azure Storage account key.
    "privatekey",
    "accountkey",
}

_KEY_NORMALIZE = re.compile(r"[^a-z0-9]")

# Value patterns. Each replaces the secret portion with REDACTED.
_VALUE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # AWS access key IDs (AKIA/ASIA/AGPA/AIDA... + 16 base32 chars)
    (re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b"), REDACTED),
    # Authorization / Bearer header values. Charset includes / + = so base64
    # tokens are masked in full, not left with a recoverable tail.
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-/+=]+"), r"\1 " + REDACTED),
    (
        re.compile(r"(?i)(authorization\s*[:=]\s*)(\S+)"),
        r"\1" + REDACTED,
    ),
    # Labeled AWS secret keys / session tokens in free text (env vars, config
    # lines, query strings): keep the label, mask the value. Anchored to a
    # secret-ish label so ordinary 40-char strings / bucket names are NOT
    # blanket-redacted. Covers `aws_secret_access_key=...`,
    # `AWS_SECRET_ACCESS_KEY: ...`, `secret_access_key = "..."`,
    # `aws_session_token=...`, `AWS_SESSION_TOKEN=...`, and the
    # `x-amz-security-token: ...` header form.
    (
        re.compile(
            r"(?i)\b((?:aws[_-]?)?secret[_-]?access[_-]?key"
            r"|aws[_-]?secret[_-]?key"
            r"|secret[_-]?key"
            r"|aws[_-]?session[_-]?token"
            r"|session[_-]?token"
            r"|security[_-]?token)(\s*[:=]\s*)(['\"]?)"
            r"[A-Za-z0-9/+=_\-]{8,}"
        ),
        r"\1\2\3" + REDACTED,
    ),
    # Cookie header text (rule 15). Requires a `key=value` shape so ordinary
    # prose ("the cookie: it was...") isn't mangled.
    (
        re.compile(r"(?i)\b((?:set-)?cookie:\s*)[^\r\n]*=[^\r\n]*"),
        r"\1" + REDACTED,
    ),
    # Presigned-URL / SigV4 query parameters (AWS + Google-style GCS SigV4).
    (
        re.compile(
            r"(?i)([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|"
            r"X-Goog-Signature|X-Goog-Credential|"
            r"Signature|AWSAccessKeyId|X-Amz-SignedHeaders)=)([^&\s]+)"
        ),
        r"\1" + REDACTED,
    ),
    # Bare `token=` / `api_key=` in free text or query strings (e.g. the local
    # SSE auth `?token=...`, a pasted `api_key=...` config line). Label kept,
    # value masked. `\b` keeps compound labels like `next_token=` (preceded by a
    # word character) from matching.
    (
        re.compile(r"(?i)\b(api[_-]?key|token)(\s*[:=]\s*)(['\"]?)[A-Za-z0-9/+=_.\-]{4,}"),
        r"\1\2\3" + REDACTED,
    ),
    # Bare `Signature=...` not in a query-param context (rule 15 lists signatures
    # generally, not only presigned-URL params). Runs after the presigned rule,
    # so an already-masked value stays masked and standalone ones get caught too.
    (re.compile(r"(?i)\b(Signature=)[^&\s]+"), r"\1" + REDACTED),
    # Model-provider API keys (OpenAI/DeepSeek-style `sk-...`, incl. `sk-proj-...`).
    # Defense-in-depth: these are resolved server-side and must never reach a
    # prompt, but a user may paste one into the chat or a provider error may echo
    # it — scrub it everywhere the shared redactor runs (messages, audit, reports).
    (re.compile(r"\bsk-[A-Za-z0-9][A-Za-z0-9_\-]{5,}\b"), REDACTED),
    # Common non-AWS provider tokens (defense-in-depth for pasted/echoed creds).
    # GitHub personal/OAuth/app tokens.
    (re.compile(r"\b(?:gh[pousr])_[A-Za-z0-9]{20,}\b"), REDACTED),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), REDACTED),
    # Slack tokens (bot/user/app/refresh/legacy: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-).
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), REDACTED),
    # Google API keys (`AIza` + 35 chars).
    (re.compile(r"\bAIza[A-Za-z0-9_\-]{35}\b"), REDACTED),
    # JSON Web Tokens (`header.payload.signature`, each base64url).
    (
        re.compile(r"\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),
        REDACTED,
    ),
    # PEM private-key blocks (GCP service-account JSON, TLS client keys) — the
    # whole armored block, any key type (RSA/EC/OPENSSH/generic).
    (
        re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----",
                   re.DOTALL),
        REDACTED,
    ),
    # TRUNCATED PEM: a BEGIN armor with no matching PRIVATE-KEY END (a partial
    # paste cut a key in half). Without this the partial key body — still secret
    # material — leaked verbatim. The lookahead blocks ONLY on a PRIVATE KEY end
    # armor (matching the full-block rule's label grammar), NOT on any foreign
    # `-----END ` — a truncated key followed by a complete CERTIFICATE block (a
    # normal .pem-bundle partial paste) previously slipped past BOTH rules.
    # Redacts from the BEGIN armor up to the next foreign armor / end of text.
    # Runs AFTER the full-block rule, so complete key blocks are already gone.
    (
        re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"
                   r"(?:(?!-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|-----BEGIN ).)*",
                   re.DOTALL),
        REDACTED,
    ),
    # Azure Storage `AccountKey=<base64>` connection-string secret. Label kept.
    (
        re.compile(r"(?i)\b(accountkey)(\s*=\s*)[A-Za-z0-9/+=]{8,}"),
        r"\1\2" + REDACTED,
    ),
    # Basic-auth userinfo in a URL (`scheme://user:pass@host`): mask the
    # password only, keep the scheme/user so the URL stays diagnosable.
    (
        re.compile(r"(?i)\b([a-z][a-z0-9+.\-]*://)([^:/?#@\s]+):([^@/?#\s]+)@"),
        r"\1\2:" + REDACTED + "@",
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
    if isinstance(value, bytes):
        # A bytes value in a JSON-like payload must not skip redaction (the
        # "recursively redact" contract); scrub as text. But decode("replace")
        # is LOSSY on non-UTF-8 binary (bytes → U+FFFD), so only substitute the
        # re-encoded form when redaction ACTUALLY matched a secret — otherwise
        # return the original bytes intact and never corrupt benign binary.
        decoded = value.decode("utf-8", "replace")
        scrubbed = redact_text(decoded)
        if scrubbed == decoded:
            return value
        return scrubbed.encode("utf-8")
    return value
