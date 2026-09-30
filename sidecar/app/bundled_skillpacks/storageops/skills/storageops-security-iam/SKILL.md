---
name: storageops-security-iam
description: 403/AccessDenied with valid credentials, or "is anything public?" — walk the authorization chain.
---

# Security and access

Chain (AWS): explicit deny > org policy > identity policy > bucket policy > ACL > public access block > KMS.
Other providers name the layers differently (RAM/CAM + bucket policy/ACL): confirm the provider first.

1. `list_buckets`: fails → an auth/signature problem, use the protocol-compat card.
2. `probe_endpoint(check="reach")`: denied at the bucket, or only on objects?
3. `review_bucket_config(aspects=["security"])`: policy verdict, ACL, public access block, encryption.
   `detail="policy"` finds the statement; `detail="ownership"` BucketOwnerEnforced = ACLs are off.
4. One key: `inspect_object(aspects=["head","acl"])` (SSE-KMS needs kms:Decrypt; an object ACL can be public).
5. Account-wide: `query_estate(survey_filter="public_buckets")`.

You cannot read the caller's identity policy: ask for it (ids redacted) with the principal and action.
Cross-account needs both sides to allow. Public = one readable public signal (policy OR ACL);
not public only when both were readable.
Stop when: the blocking layer is named, marked verified or inferred. Credentials in pasted logs:
warn to rotate. Fixes are text the user applies; never suggest disabling auth.
