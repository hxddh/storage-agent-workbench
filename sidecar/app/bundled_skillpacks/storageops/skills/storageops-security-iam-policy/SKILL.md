---
name: storageops-security-iam-policy
description: >
  Diagnose object-storage permission errors — 403 AccessDenied, 401
  Unauthorized, forbidden. Trace the authorization chain (explicit deny → org
  policy → identity policy → bucket policy → ACL → public-access block → KMS),
  handle cross-account and encryption cases, and flag credential leaks. Use when
  access is denied but the credentials themselves are valid.
domains: [security]
trigger_keywords:
  - 403 AccessDenied
  - 401 Unauthorized
  - permission denied
  - access denied
  - IAM policy
  - bucket policy
  - cross-account
  - KMS
---

# Security, IAM & Permission Diagnosis

Find why access was denied by walking the permission chain. On AWS this is
**Explicit Deny → SCP → IAM → Bucket Policy → ACL → Block Public Access (→ KMS)**;
on OSS/BOS/COS the model is RAM/CAM + bucket policy/ACL — confirm the provider
first, because the layer names differ.

## Decision tree

```
403 AccessDenied (credentials are valid) →
  ├─ Message says "explicit deny"         → a Deny statement wins; find it
  ├─ Message says "no policy allows"       → missing Allow on identity OR resource
  ├─ Cross-account?                         → BOTH sides must grant
  │     ├─ caller identity policy allows the action + resource?
  │     └─ target bucket policy grants the caller principal?
  ├─ Object is SSE-KMS / SSE-C?             → also needs kms:Decrypt on the key
  ├─ Public/anonymous access expected?      → Block Public Access / bucket ACL
  └─ Works for some keys, not others        → prefix-scoped policy condition
```

## Investigate with your read-only tools

- `test_credentials` — confirm the keys are valid and see the identity reached.
  If this fails, it's an auth problem, not a policy one — switch to
  `storageops-s3-protocol-compatibility` (signature) or
  `storageops-network-endpoint-access`.
- `head_bucket` — does the denial happen at the bucket level or only on objects?
- `head_object` on a specific key — confirm a per-key 403 vs 404, and read the
  object's storage class / SSE state (KMS-encrypted objects need key access).
- `review_bucket_security` (or `get_bucket_config_summary`) — read the bucket's
  policy/ACL/public-access-block/encryption posture and point to the layer that
  blocks. For a full posture check run `review_bucket_config` (inline,
  read-only); to enumerate the whole account, run `survey_account`.

You read configuration; you cannot read the caller's IAM/RAM identity policy — so
identity-side denials must be confirmed from the policy document the user shares.

## Ask the user (only what tools can't reveal)

- The exact error body (code + message + request id) and the S3 action attempted.
- The principal (IAM role/user ARN, or RAM/CAM identity) making the call.
- The identity policy and/or bucket policy JSON (account ids redacted).
- Whether it's cross-account, and whether a VPC endpoint is involved.

## Credential safety

If shared logs contain an Authorization header, AK/SK pair, session token, or a
presigned URL with credentials, stop and warn: the credential is exposed and
must be rotated and the logs redacted. Never propose disabling auth as a fix.

## What to report

The blocked layer (identity / bucket policy / ACL / public-access block / KMS /
explicit-deny), marked tool-verified vs. inferred-from-policy; a manual-only
remediation the user reviews with their security team; a safe read-only way to
confirm the fix; and the evidence that would falsify the diagnosis.
