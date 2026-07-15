"""Rule-based triage playbooks.

A small, curated set of rules — NOT an exhaustive error-code dictionary. Each
rule maps a parsed signal to candidate causes, the evidence to check, safe next
checks (read-only), related run types, and provider caveats. Rules NEVER emit a
mutating command; suggested actions are Phase 17 proposal action_types only.
"""

from __future__ import annotations

from typing import Any

# Allowed proposal action types for triage (subset of the Phase 17 allowlist).
# run_diagnostic, run_bucket_config_review, plan_access_log_import,
# ask_user_for_context, generate_session_report.


def _entry(code, category, title, confidence, likely_causes, evidence, next_checks,
           related_run_types, provider_caveats, proposals) -> dict[str, Any]:
    return {
        "code": code, "category": category, "title": title, "confidence": confidence,
        "likely_causes": likely_causes, "evidence_to_check": evidence, "next_checks": next_checks,
        "related_run_types": related_run_types, "provider_caveats": provider_caveats,
        "proposals": proposals,
    }


_DIAG = {"action_type": "run_diagnostic", "title": "Run a diagnostic",
         "reason": "Read-only credential / reachability / addressing checks.", "confidence": "medium"}
_CFG = {"action_type": "run_bucket_config_review", "title": "Review bucket configuration",
        "reason": "Inspect policy / ACL / encryption / public access posture.", "confidence": "medium"}
_LOGS = {"action_type": "plan_access_log_import", "title": "Import recent access logs",
         "reason": "Correlate the errors with request/throttle patterns over time.", "confidence": "medium"}
_ASK = {"action_type": "ask_user_for_context", "title": "Ask for more context",
        "reason": "A few details would disambiguate the likely cause.", "confidence": "low"}

# Bridge from a triage category to the StorageOps specialist skill whose method
# applies. Deterministic triage has no model, so it can't `read_skill` itself —
# but surfacing the pointer lets a session agent (which does have the catalog)
# jump straight to the right method, and tells an offline user which skill covers
# their case. Categories are stable; anything unmapped falls back to triage.
_CATEGORY_SKILL: dict[str, str] = {
    "auth": "storageops-s3-protocol-compatibility",
    "authz": "storageops-security-iam-policy",
    "availability": "storageops-performance-diagnosis",
    "client": "storageops-data-consistency",
    "connectivity": "storageops-network-endpoint-access",
    "routing": "storageops-s3-protocol-compatibility",
    "throttling": "storageops-performance-diagnosis",
    "unknown": "storageops-triage",
}


def skill_for_category(category: str) -> str:
    """The specialist skill a triage category maps to (defaults to triage)."""
    return _CATEGORY_SKILL.get(category, "storageops-triage")


# Keyed by S3 error code.
_BY_CODE: dict[str, dict[str, Any]] = {
    "SignatureDoesNotMatch": _entry(
        "SignatureDoesNotMatch", "auth", "Request signature did not match", "medium",
        ["region mismatch between client and bucket", "endpoint mismatch",
         "path-style vs virtual-hosted-style addressing mismatch", "canonical URI encoding issue",
         "client clock skew", "a proxy modified signed headers",
         "presigned URL query was stripped or reordered", "S3-compatible signing incompatibility"],
        ["client region vs bucket region", "configured endpoint vs provider endpoint",
         "addressing style", "request timestamp vs server time"],
        ["test_credentials", "inspect_endpoint_tls", "test_addressing_style",
         "get_bucket_config_summary / head_bucket", "compare client region and endpoint", "check request time skew"],
        ["diagnostic", "bucket_config_review"],
        ["S3-compatible providers may differ in SigV4 canonicalization or require path-style."],
        [_DIAG, _ASK]),
    "AccessDenied": _entry(
        "AccessDenied", "authz", "Access denied", "medium",
        ["wrong or insufficient credentials", "bucket policy deny", "missing IAM permission",
         "ACL / public-access-block restriction", "KMS/encryption key permission",
         "cross-account access not granted", "provider-specific permission model"],
        ["which principal/credential was used", "bucket policy + ACL + public access block",
         "whether the operation requires extra permissions (e.g. kms:Decrypt)"],
        ["test_credentials", "review bucket policy / ACL / public access block (read-only)",
         "confirm the operation and resource the credential is allowed"],
        ["bucket_config_review", "diagnostic"],
        ["Some providers return AccessDenied for unsupported APIs; treat capability gaps separately."],
        [_CFG, _DIAG, _ASK]),
    "InvalidAccessKeyId": _entry(
        "InvalidAccessKeyId", "auth", "Access key not recognized", "high",
        ["stale or rotated access key", "wrong credential profile", "wrong account/provider"],
        ["which credential profile is in use", "whether the key was rotated"],
        ["test_credentials", "confirm the configured provider credentials"],
        ["diagnostic"], [], [_DIAG, _ASK]),
    "NoSuchBucket": _entry(
        "NoSuchBucket", "routing", "Bucket does not exist (from this endpoint/region)", "medium",
        ["bucket name typo", "wrong region/endpoint so the bucket is not visible", "bucket deleted"],
        ["exact bucket name", "endpoint + region targeted"],
        ["head_bucket", "get_bucket_config_summary", "verify endpoint/region"],
        ["diagnostic"], ["On some providers a region/endpoint mismatch surfaces as NoSuchBucket."],
        [_DIAG, _ASK]),
    "NoSuchKey": _entry(
        "NoSuchKey", "client", "Object key not found", "high",
        ["key typo or wrong prefix", "object not yet written / already expired", "wrong bucket"],
        ["the exact key/prefix requested", "whether a lifecycle rule expired it"],
        ["head_object on the exact key", "list a bounded prefix to confirm naming"],
        ["diagnostic"], [], [_ASK]),
    "PermanentRedirect": _entry(
        "PermanentRedirect", "routing", "Bucket is in a different region/endpoint", "high",
        ["region mismatch", "wrong endpoint", "bucket location differs from client config",
         "virtual-hosted-style routing issue"],
        ["bucket location vs client region", "endpoint used"],
        ["get_bucket_config_summary", "head_bucket", "test_addressing_style", "align endpoint/region"],
        ["diagnostic"], ["S3-compatible providers may not emit a redirect; they may just fail."],
        [_DIAG, _ASK]),
    "AuthorizationHeaderMalformed": _entry(
        "AuthorizationHeaderMalformed", "routing", "Authorization header region/format mismatch", "high",
        ["region in the request differs from the bucket region", "malformed/altered Authorization header"],
        ["region declared in the request vs bucket region"],
        ["get_bucket_config_summary", "align the signing region", "test_credentials"],
        ["diagnostic"], [], [_DIAG, _ASK]),
    "RequestTimeTooSkewed": _entry(
        "RequestTimeTooSkewed", "auth", "Client clock skew", "high",
        ["client system clock is wrong", "timezone handling bug"],
        ["client time vs server time delta"],
        ["sync the client clock (NTP)", "check request time skew", "retry after correcting time"],
        ["diagnostic"], [], [_ASK]),
    "SlowDown": _entry(
        "SlowDown", "throttling", "Provider is throttling the request rate", "medium",
        ["request rate too high", "per-prefix or per-account throttle", "client retry storm",
         "multipart concurrency too high", "provider-side quota"],
        ["request rate over time", "concurrency/retry settings", "key/prefix hot-spotting"],
        ["import recent access logs to see the rate pattern", "reduce concurrency / add backoff",
         "spread load across prefixes"],
        ["access_log_analysis"], ["Per-prefix throttle thresholds vary by provider."],
        [_LOGS, _ASK]),
    "TooManyRequests": _entry(
        "TooManyRequests", "throttling", "Rate limited (429)", "medium",
        ["request rate too high", "account/prefix quota", "retry storm"],
        ["request rate over time", "retry/backoff configuration"],
        ["import recent access logs", "reduce concurrency / add exponential backoff"],
        ["access_log_analysis"], [], [_LOGS, _ASK]),
    "RequestTimeout": _entry(
        "RequestTimeout", "availability", "Request timed out", "medium",
        ["client timeout too low", "slow network path", "large multipart part", "provider latency"],
        ["client timeout settings", "object/part size", "network path"],
        ["retry with backoff", "increase client timeout", "inspect_endpoint_tls / connectivity"],
        ["diagnostic"], [], [_DIAG, _ASK]),
    "InvalidBucketName": _entry(
        "InvalidBucketName", "client", "Bucket name is invalid", "high",
        ["bucket name violates naming rules", "path/virtual-host addressing of a non-DNS-safe name"],
        ["the exact bucket name", "addressing style"],
        ["use a DNS-compliant bucket name", "try path-style addressing"],
        ["diagnostic"], [], [_ASK]),
    "InvalidPart": _entry(
        "InvalidPart", "client", "Multipart part invalid", "medium",
        ["part ETag/number mismatch at complete", "a part upload failed silently", "part size below minimum"],
        ["recorded part numbers/ETags", "part sizes (>=5 MiB except last)"],
        ["re-list parts", "re-upload the failed part", "verify part sizes"],
        ["diagnostic"], [], [_ASK]),
    "EntityTooSmall": _entry(
        "EntityTooSmall", "client", "Multipart part too small", "high",
        ["a non-final part is below the 5 MiB minimum"],
        ["per-part sizes"],
        ["increase part size to >= 5 MiB (except the last part)"],
        [], [], [_ASK]),
    "PreconditionFailed": _entry(
        "PreconditionFailed", "client", "Precondition failed", "medium",
        ["If-Match/If-None-Match/If-Modified-Since condition not met", "ETag changed concurrently"],
        ["the conditional headers sent", "current object ETag"],
        ["re-fetch current ETag and retry", "remove or correct the precondition"],
        ["diagnostic"], [], [_ASK]),
    "InvalidObjectState": _entry(
        "InvalidObjectState", "client", "Object is archived (GLACIER / DEEP_ARCHIVE)", "high",
        ["the object's storage class is an archive tier, so GET is not allowed until restored",
         "a restore was requested but has not completed yet", "a completed restore already expired"],
        ["the object's storage class", "its restore status (in progress / expiry)"],
        ["head_object on the exact key — it reports storage_class, archive_status, and the "
         "x-amz-restore state (restore in progress / restored-until)",
         "if not restored: initiate a restore from your own tooling (this app is read-only), "
         "then retry the GET after it completes"],
        ["diagnostic"],
        ["Archive tiers and restore semantics vary by provider (e.g. OSS Archive needs Restore too)."],
        [_DIAG, _ASK]),
    "ExpiredToken": _entry(
        "ExpiredToken", "auth", "Session token has expired", "high",
        ["STS/temporary credentials expired", "a long-running job outlived its session",
         "cached credentials not refreshed"],
        ["when the credentials were issued and their duration", "whether a refresh path exists"],
        ["test_credentials — confirms the stored credential is rejected",
         "re-issue the session token / re-assume the role, then update the provider credentials"],
        ["diagnostic"], [], [_DIAG, _ASK]),
    "NotImplemented": _entry(
        "NotImplemented", "client", "Provider does not implement this API (capability gap)", "high",
        ["the S3-compatible provider does not support the API you called (rule: this is a "
         "capability gap, NOT a failure)", "an optional header/feature the provider ignores"],
        ["which API/operation returned 501", "the provider/endpoint in use"],
        ["get_bucket_config_summary — its per-aspect statuses mark unsupported APIs as "
         "provider_unsupported so you can see the provider's real surface",
         "use the fallback the equivalent skill suggests (e.g. head_object instead of "
         "get_object_attributes)"],
        ["bucket_config_review"],
        ["MinIO/Ceph/OSS/COS each omit different config APIs; design around provider_unsupported."],
        [_CFG, _ASK]),
}

# KMS-encrypted-object denials: same playbook for the three KMS.* codes.
_KMS = _entry(
    "KMS.AccessDenied", "authz", "KMS key access denied (SSE-KMS object)", "high",
    ["the caller lacks kms:Decrypt (or kms:GenerateDataKey for writes) on the object's KMS key",
     "the KMS key is disabled or scheduled for deletion", "the key policy does not grant the caller",
     "cross-account: the key policy must grant the external account explicitly"],
    ["the object's SSE mode and KMS key (head_object shows SSE state)",
     "the caller's kms:Decrypt permission on that key", "the key's enabled/disabled state"],
    ["head_object on the exact key — confirms it is SSE-KMS encrypted and which key id style applies",
     "review the key policy + caller IAM for kms:Decrypt (identity-side; share the policy redacted)"],
    ["bucket_config_review", "diagnostic"],
    ["S3-compatible providers may not surface KMS.* codes; a plain AccessDenied on an encrypted "
     "object has the same likely cause."],
    [_CFG, _ASK])


def _alias(code: str, base: dict[str, Any], title: str | None = None) -> dict[str, Any]:
    """A code-level alias of an existing entry (same guidance, correct code echo)."""
    out = dict(base)
    out["code"] = code
    if title:
        out["title"] = title
    return out

# Synthetic categories keyed off parsed flags / HTTP status when no code matched.
_TLS = _entry(
    "TLS", "connectivity", "TLS / certificate problem", "medium",
    ["expired/self-signed/untrusted certificate", "SNI/hostname mismatch", "TLS version/cipher mismatch",
     "interception proxy"],
    ["certificate subject/issuer/expiry", "endpoint hostname vs cert"],
    ["inspect_endpoint_tls", "verify the endpoint hostname and CA trust"],
    ["diagnostic"], ["Custom S3-compatible endpoints may use private CAs."], [_DIAG, _ASK])
_CONN = _entry(
    "ConnectionError", "connectivity", "Network connection failed", "medium",
    ["DNS/endpoint unreachable", "firewall/proxy blocking", "client timeout too low", "transient network"],
    ["endpoint resolvability", "proxy settings", "timeout configuration"],
    ["inspect_endpoint_tls / connectivity to the endpoint", "retry with backoff", "verify endpoint/region"],
    ["diagnostic"], [], [_DIAG, _ASK])
_5XX = _entry(
    "ServerError", "availability", "Provider-side 5xx error", "medium",
    ["transient provider error", "gateway/proxy issue", "large multipart retry", "provider degradation"],
    ["which operation/endpoint", "whether retries succeed"],
    ["retry with exponential backoff", "inspect_endpoint_tls / connectivity", "check provider status"],
    ["diagnostic"], [], [_DIAG, _ASK])
_PAGINATION = _entry(
    "Pagination", "client", "Listing pagination / continuation-token issue", "low",
    ["continuation token not passed back", "assuming a single page", "mixing delimiter/prefix incorrectly"],
    ["whether IsTruncated was handled", "how the continuation token is threaded"],
    ["page using NextContinuationToken until IsTruncated is false", "use a bounded list to verify"],
    ["diagnostic"], [], [_ASK])

# Orphaned known codes (previously parsed but unmapped → fell through to
# "Could not classify") + the KMS aliases. Same guidance as their canonical
# entries, with the pasted code echoed back correctly.
_BY_CODE.update({
    "ServiceUnavailable": _alias("ServiceUnavailable", _BY_CODE["SlowDown"],
                                 "Service unavailable (503) — usually throttling"),
    "Throttling": _alias("Throttling", _BY_CODE["TooManyRequests"], "Request throttled"),
    "InternalError": _alias("InternalError", _5XX, "Provider-side InternalError (500)"),
    "BadGateway": _alias("BadGateway", _5XX, "Bad gateway (502) — proxy/provider issue"),
    "InvalidToken": _alias("InvalidToken", _BY_CODE["ExpiredToken"],
                           "Session token invalid/malformed"),
    "MethodNotAllowed": _alias("MethodNotAllowed", _BY_CODE["NotImplemented"],
                               "Method not allowed — likely a provider capability gap"),
    "KMS.AccessDenied": _KMS,
    "KMS.DisabledException": _alias("KMS.DisabledException", _KMS,
                                    "KMS key is disabled (SSE-KMS object unreadable)"),
    "KMS.NotFoundException": _alias("KMS.NotFoundException", _KMS,
                                    "KMS key not found (deleted or wrong region)"),
})


def match(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the playbook entries relevant to the parsed signals (bounded)."""
    out: list[dict[str, Any]] = []
    code = parsed.get("error_code")
    if code and code in _BY_CODE:
        out.append(_BY_CODE[code])

    flags = parsed.get("flags", {}) or {}
    http = parsed.get("http_status")

    if flags.get("tls_or_cert"):
        out.append(_TLS)
    if flags.get("connection_error"):
        out.append(_CONN)
    if flags.get("pagination_hint"):
        out.append(_PAGINATION)
    if http and 500 <= int(http) <= 599 and not any(e["code"] == "ServerError" for e in out):
        out.append(_5XX)
    if http in (429,) and not any(e["category"] == "throttling" for e in out):
        out.append(_BY_CODE["TooManyRequests"])

    if not out:
        # Nothing matched — return a generic "needs more context" entry.
        out.append(_entry(
            "Unknown", "unknown", "Could not classify the error deterministically", "low",
            ["the input did not contain a recognized S3 error code or signal"],
            ["the exact error code / HTTP status / operation"],
            ["paste the full (redacted) SDK error or HTTP response", "include the operation and endpoint/region"],
            [], [], [_ASK]))
    return out[:6]
