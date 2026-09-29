"""The issue rules — which deterministic observations are an Issue.

An Issue is opened only from deterministic engine output: the survey's
per-bucket posture flags and the config review's findings. Model prose never
opens, resolves or re-grades one. Each rule has a stable ``code`` (the issue
fingerprint is provider + bucket + code), a severity on the product scale
(high | medium | low), the config-review titles that assert it, and — where
the survey can decide it — a posture predicate.

A rule is *evaluated* for a bucket only when the source could actually decide
it: an unreadable, denied or unsupported read decides nothing, and an issue it
cannot see is never resolved by that silence.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

# Tri-state verdict of one rule on one bucket: True = present, False = absent,
# None = this source could not decide.
Verdict = bool | None


@dataclass(frozen=True)
class Rule:
    code: str
    severity: str
    title: dict[str, str]  # en / zh
    check: str  # which read-only review re-checks it: "security" | "lifecycle"
    review_titles: tuple[str, ...]
    posture: Callable[[dict[str, Any]], Verdict] | None = None


def _public(p: dict[str, Any]) -> Verdict:
    v = p.get("publicly_exposed")
    return None if v is None else bool(v)


def _no_encryption(p: dict[str, Any]) -> Verdict:
    s = p.get("encryption_status")
    if s == "not_configured":
        return True
    if s == "available":
        return False
    return None


def _no_pab(p: dict[str, Any]) -> Verdict:
    # "available" only says a block exists — it may still be incomplete, which
    # the survey cannot see. Only the config review decides that case.
    return True if p.get("public_access_block_status") == "not_configured" else None


def _no_lifecycle(p: dict[str, Any]) -> Verdict:
    # No lifecycle at all means no AbortIncompleteMultipartUpload rule; a
    # configured lifecycle may or may not carry one (the review decides).
    return True if p.get("lifecycle_status") == "not_configured" else None


RULES: tuple[Rule, ...] = (
    Rule("public_exposure", "high",
         {"en": "Bucket is publicly accessible", "zh": "存储桶可被公开访问"},
         "security",
         ("Anonymous s3:GetObject allowed", "Anonymous s3:ListBucket allowed",
          "ACL grants public access", "Bucket policy makes this bucket PUBLIC (AWS verdict)"),
         _public),
    Rule("wildcard_principal", "medium",
         {"en": "Bucket policy allows a wildcard principal", "zh": "存储桶策略允许通配主体"},
         "security", ("Bucket policy allows a wildcard principal",)),
    Rule("cors_all_origins", "medium",
         {"en": "CORS allows all origins", "zh": "CORS 允许所有来源"},
         "security", ("CORS allows all origins",)),
    Rule("no_default_encryption", "medium",
         {"en": "No default encryption", "zh": "未配置默认加密"},
         "security", ("No default encryption",), _no_encryption),
    Rule("public_access_block_missing", "medium",
         {"en": "Public access block not fully enabled", "zh": "公共访问阻止未完全开启"},
         "security", ("Public access block incomplete", "Public access block not configured"),
         _no_pab),
    Rule("no_abort_mpu", "medium",
         {"en": "Incomplete multipart uploads are never cleaned up", "zh": "未清理未完成的分段上传"},
         "lifecycle", ("No AbortIncompleteMultipartUpload rule", "No incomplete-multipart cleanup"),
         _no_lifecycle),
    Rule("noncurrent_never_expire", "medium",
         {"en": "Noncurrent versions never expire", "zh": "非当前版本永不过期"},
         "lifecycle", ("Versioning enabled without noncurrent cleanup",
                       "Noncurrent versions never expire")),
)

BY_CODE = {r.code: r for r in RULES}
_BY_TITLE = {t: r for r in RULES for t in r.review_titles}

# Findings that mean "this review could not see everything" — a review that
# reports one of these decides nothing it could not read.
_BLIND_PREFIXES = ("Access denied reading", "Could not read", "Policy not public, but ACL unreadable")
_BLIND_SUFFIXES = ("not supported", "not supported by provider")

SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2, "info": 3}

# The posture projection kept on estate_buckets: status enums and booleans
# only — never raw policy/ACL/configuration documents.
POSTURE_KEYS = (
    "head_bucket_status", "access_status", "versioning_status", "versioning_enabled",
    "encryption_status", "lifecycle_status", "logging_status", "logging_enabled",
    "replication_status", "policy_status", "public_access_block_status",
    "policy_public_status", "policy_is_public", "object_ownership", "acls_disabled",
    "acl_public", "publicly_exposed", "tagging_status", "inventory_status",
)


def posture_projection(snapshot: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k in POSTURE_KEYS:
        v = snapshot.get(k)
        if v is None or isinstance(v, bool):
            out[k] = v
        else:
            out[k] = str(v)[:64]
    return out


def title(rule: Rule, lang: str = "en") -> str:
    return rule.title.get("zh" if str(lang).lower().startswith("zh") else "en", rule.title["en"])


def evaluate_posture(posture: dict[str, Any]) -> dict[str, Verdict]:
    """Every rule the survey's posture flags can decide, with its verdict."""
    out: dict[str, Verdict] = {}
    for rule in RULES:
        if rule.posture is None:
            continue
        verdict = rule.posture(posture)
        if verdict is not None:
            out[rule.code] = verdict
    return out


def _blind(finding_title: str) -> bool:
    return finding_title.startswith(_BLIND_PREFIXES) or finding_title.endswith(_BLIND_SUFFIXES)


def evaluate_review(check: str, output: dict[str, Any]) -> tuple[dict[str, Verdict], dict[str, str]]:
    """(verdicts, details) for the rules one review tool (``security`` or
    ``lifecycle``) decides, from its sanitized output.

    A rule whose title appears is present. A rule that does not appear is
    absent only if the review ran and reported no blind spot; otherwise the
    review decided nothing about it."""
    verdicts: dict[str, Verdict] = {}
    details: dict[str, str] = {}
    if not isinstance(output, dict) or output.get("success") is False:
        return verdicts, details
    findings = [f for f in (output.get("findings") or []) if isinstance(f, dict)]
    blind = any(_blind(str(f.get("title", ""))) for f in findings)
    for f in findings:
        rule = _BY_TITLE.get(str(f.get("title", "")))
        if rule is None or rule.check != check:
            continue
        verdicts[rule.code] = True
        detail = str(f.get("detail") or f.get("title"))[:400]
        details[rule.code] = (details[rule.code] + " " + detail) if rule.code in details else detail
    if not blind:
        for rule in RULES:
            if rule.check == check and rule.code not in verdicts:
                verdicts[rule.code] = False
    return verdicts, details


# --- generated fixes ----------------------------------------------------------
# A fix is text the USER applies with their own credentials. Storage Agent
# never writes to storage; these are deterministic templates, not model output.

_PAB = {"BlockPublicAcls": True, "IgnorePublicAcls": True,
        "BlockPublicPolicy": True, "RestrictPublicBuckets": True}
_SSE = {"Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"},
                   "BucketKeyEnabled": True}]}


def _lifecycle(rule_body: dict[str, Any], rule_id: str) -> dict[str, Any]:
    return {"Rules": [{"ID": rule_id, "Status": "Enabled", "Filter": {}, **rule_body}]}


def _q(value: dict[str, Any]) -> str:
    return "'" + json.dumps(value, separators=(",", ":")) + "'"


def generate_fix(code: str, bucket: str) -> dict[str, Any] | None:
    """A deterministic fix for one rule on one bucket, or None when the fix
    depends on intent the rule cannot know (a policy's legitimate principals,
    an application's CORS origins)."""
    b = bucket
    if code in ("public_exposure", "public_access_block_missing"):
        doc = _PAB
        return {
            "kind": "public_access_block",
            "document": doc,
            "command": f"aws s3api put-public-access-block --bucket {b} "
                       f"--public-access-block-configuration {_q(doc)}",
            "notes": ["Blocks public ACLs and public policies for this bucket.",
                      "If the bucket serves a website or public downloads on purpose, "
                      "put a CDN with origin access in front of it first."]
                     + (["Also review the bucket policy and ACL grants that made it public."]
                        if code == "public_exposure" else []),
        }
    if code == "no_default_encryption":
        return {
            "kind": "default_encryption",
            "document": _SSE,
            "command": f"aws s3api put-bucket-encryption --bucket {b} "
                       f"--server-side-encryption-configuration {_q(_SSE)}",
            "notes": ["Applies SSE-S3 (AES256) to new objects; existing objects are unchanged.",
                      "Use aws:kms with your key instead if your policy requires KMS."],
        }
    if code == "no_abort_mpu":
        doc = _lifecycle({"AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}},
                         "abort-incomplete-mpu-7d")
        return {
            "kind": "lifecycle",
            "document": doc,
            "command": f"aws s3api put-bucket-lifecycle-configuration --bucket {b} "
                       f"--lifecycle-configuration {_q(doc)}",
            "notes": ["This call REPLACES the bucket's lifecycle configuration: merge this rule "
                      "into any existing rules before applying."],
        }
    if code == "noncurrent_never_expire":
        doc = _lifecycle({"NoncurrentVersionExpiration": {"NoncurrentDays": 30}},
                         "expire-noncurrent-30d")
        return {
            "kind": "lifecycle",
            "document": doc,
            "command": f"aws s3api put-bucket-lifecycle-configuration --bucket {b} "
                       f"--lifecycle-configuration {_q(doc)}",
            "notes": ["Noncurrent versions older than 30 days are deleted — choose the retention "
                      "your recovery policy needs.",
                      "This call REPLACES the bucket's lifecycle configuration: merge this rule "
                      "into any existing rules before applying."],
        }
    return None
