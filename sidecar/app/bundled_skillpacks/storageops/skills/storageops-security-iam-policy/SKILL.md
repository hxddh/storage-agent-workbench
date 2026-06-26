---
name: storageops-security-iam-policy
description: >
  Diagnose S3 permission errors (403 AccessDenied, 401 Unauthorized).
  Analyze IAM policies, bucket policies, ACLs, block public access settings,
  and cross-account access chains. Scan for credential leaks in logs.
  Use when user reports access denied, forbidden, or authorization failures.
maturity: core
mode: light_heavy
estimated_tokens: 1400
trigger_keywords:
  - 403 AccessDenied
  - 403 Forbidden
  - 401 Unauthorized
  - permission denied
  - access denied
  - IAM policy
  - bucket policy
  - cross-account
  - credential leak
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
---

# Security, IAM & Permission Diagnosis

Trace the permission evaluation chain to find why access was denied. The S3 authorization model evaluates: **Explicit Deny → SCP (Org) → IAM Policy → Bucket Policy → ACL → Block Public Access**.

## Decision Tree

```
403 AccessDenied →
  ├─ Error message contains "explicit deny"? → Explicit Deny in policy → Find the Deny statement
  ├─ Error message contains "no policy allows"? → Missing Allow → Check IAM + Bucket policy
  ├─ Cross-account access? → Both sides needed
  │   ├─ Source account: IAM role/user must allow `sts:AssumeRole` + S3 actions
  │   └─ Target account: Bucket policy must grant access to source principal
  ├─ Public access blocked? → Check Block Public Access settings
  ├─ KMS-related? (kms:Decrypt, kms:GenerateDataKey) → KMS key policy
  └─ VPC endpoint? → Check VPC endpoint policy
```

## Workflow

### Step 1: Extract Error Details
From the error response: status code, error code (AccessDenied/Unauthorized), error message, request ID, and the principal ARN if available.

### Step 2: Identify the Failing Action
What S3 action was attempted? (s3:GetObject, s3:PutObject, s3:ListBucket, etc.) The error message often includes the action.

### Step 3: Trace the Permission Chain
Evaluate in order: Explicit Deny → SCP → IAM Policy → Bucket Policy → ACL → Block Public Access. Stop at the first denial. See `references/policy-evaluation.md`.

### Step 4: Special Scenarios
- **Cross-account**: Both source IAM and target bucket policy must grant access
- **KMS**: Both S3 action AND kms:Decrypt on the KMS key are needed
- **VPC Endpoint**: VPC endpoint policy can deny even if IAM+bucket allow
- **STS/AssumeRole**: Check trust policy if using assumed roles

### Step 5: Credential Scanning
If logs are provided, scan for exposed credentials: AK/SK pairs, session tokens, signed URLs with credentials, Authorization headers. Report any findings as `[CREDENTIAL_LEAK]`.

### Step 6: Feedback Loop
If the user provides a policy JSON document, run `python3 scripts/policy_analyzer.py --file <policy.json>` to automatically identify explicit Deny statements, overly broad permissions, and public access risks. For a **cross-account** denial where both the caller IAM policy and the bucket policy are available, run `python3 scripts/cross_account_access_validator.py --principal-arn <arn> --action s3:GetObject --resource arn:aws:s3:::<bucket>/<key> --resource-account <owner-acct> --identity-policy <iam.json> --bucket-policy <bucket.json> [--kms-key-policy <key.json>]` to deterministically report which link in the AND-chain (identity / resource / KMS) breaks — this catches the common "fixed one side, still blocked" trap. After diagnosis, ask user to test: 'Run `aws s3 ls s3://<bucket> --profile <profile>` to confirm the issue persists. If the fix works, also test a secondary action like `aws s3 cp`.' If confidence < medium or root cause is unclear, go back to Step 3 (Permission Chain) and request the IAM policy document or bucket policy JSON from the user.

## User Interaction

### When to ask the user:
- 'What is the exact error message and HTTP status code? (Share complete error XML/JSON)'
- 'What IAM role or user are you using? (ARN if available)'
- 'Can you share the IAM policy or bucket policy document? (Redact account IDs and sensitive ARNs)'
- 'Are you accessing cross-account? If yes, what are the source and target account IDs?'
- 'Is there a VPC endpoint involved? What is the endpoint policy?'

### When to inform the user:
- Before suggesting policy changes: 'This is a recommended policy change. Please review with your security team before applying.'
- For credential leaks: '⚠️ CRITICAL: Rotate exposed credentials immediately. Redact logs containing these secrets.'
- After diagnosis: 'Please validate the fix in a staging/test environment before applying to production.'

## Output Contract — include these fields

```markdown
## Summary
[one-line diagnosis]
**Route**: storageops-security-iam-policy
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[explicit-deny|missing-allow|cross-account-gap|kms|vpc-endpoint|public-access-block|credential-leak], affected_layer=[identity|bucket-policy|kms|network-policy|credential]

## Key Evidence
- Error: [code + message excerpt]
- Principal: [ARN if known]
- Action: [S3 action]
- Permission chain trace: Explicit Deny [found/none] → IAM [allow/deny] → Bucket Policy [allow/deny] → Block Public Access [on/off] → **Blocked at**: [layer]
- Credential scan: [scan_secrets findings, if any]

## Remediation
1. **[fix]** (manual-only) — [policy change needed]
2. **[workaround]** — [if applicable]
- Validation: [read-only policy simulator, identity check, or scoped test to confirm]

## What Would Falsify This
- [policy, KMS, or credential evidence that would overturn the diagnosis]

## Risks / Open Questions
- [blast radius, missing principal/action/resource, manual-only approval needed]
```

## Examples

### Example 1: Missing bucket policy for cross-account
**Input**: `AccessDenied: User arn:aws:iam::111:role/app is not authorized to perform s3:GetObject on arn:aws:s3:::bucket-222/file`
**Diagnosis**: Cross-account — role has IAM allow, but bucket-222 has no bucket policy granting access to account 111
**Recommendation**: Add bucket policy on bucket-222 granting `s3:GetObject` to `arn:aws:iam::111:role/app`

### Example 2: Explicit deny by SCP
**Input**: `AccessDenied: Access denied by explicit deny in organization SCP. Action: s3:PutObject`
**Diagnosis**: SCP explicit deny — organization policy blocks PutObject
**Recommendation**: Review organization SCP; request exception if needed. Cannot be overridden by IAM or bucket policy.

### Example 3: Credentials in logs
**Input**: Debug log contains `Authorization: AWS4-HMAC-SHA256 Credential=AKIA.../.../s3/aws4_request`
**Diagnosis**: CREDENTIAL_LEAK — AWS access key ID in logs
**Recommendation**: Immediately rotate the exposed key, revoke affected sessions if applicable, and redact all logs containing this key before sharing them. Do not disable authentication as a workaround.

## References
- `scripts/policy_analyzer.py` — Offline analyzer for a single IAM/bucket policy (explicit Deny, broad actions, public access); run `python3 scripts/policy_analyzer.py --file <policy.json>` | **Run when:** the user shares one policy document to audit
- `scripts/cross_account_access_validator.py` — Offline AND-chain evaluator across the caller IAM policy + bucket policy (+ optional KMS key policy); reports the broken link; **AWS IAM model** (emits `"model":"aws"`; OSS RAM / COS CAM differ — see `references/provider-differences.md`) | **Run when:** a cross-account 403 and both the identity and resource policies are available
- `references/policy-evaluation.md` — Full permission evaluation order with examples | **Read when:** user reports 403/401 and has IAM/bucket policy documents to share
- `references/cross-account.md` — Cross-account setup patterns | **Read when:** user mentions multiple AWS accounts, cross-account access, or ARNs from different account IDs
- `references/kms-permissions.md` — KMS key policy requirements | **Read when:** user mentions KMS, encryption keys, kms:Decrypt, or server-side encryption errors
- `references/vpc-endpoints.md` — VPC endpoint policy diagnosis | **Read when:** user mentions VPC endpoints, private subnets, or access from within AWS network
- `references/provider-differences.md` — IAM model differences (BOS/OSS/COS vs AWS) | **Read when:** user uses non-AWS S3 providers (Alibaba OSS, Baidu BOS, Tencent COS, GCS)
- `references/access-denied.md` — Anatomy of the 403 response and how to read the denial reason | **Read when:** user pastes a 403 AccessDenied body and you need to map the message to a cause
- `references/bucket-policy.md` — Bucket (resource) policy structure and common grant mistakes | **Read when:** user shares a bucket policy or the denial is on the resource side
- `references/kms-sse.md` — KMS/SSE encryption types and the key-policy grants S3 needs | **Read when:** the object is SSE-KMS/SSE-C and access fails despite an S3 allow
- `references/sts-token.md` — STS temporary-credential structure and assume-role trust pitfalls | **Read when:** the caller uses an assumed role / session token and gets denied
- `references/secret-redaction.md` — What to redact (AK/SK, session tokens, signed URLs) and how | **Read when:** logs or policies may contain credentials and must be sanitized before sharing
