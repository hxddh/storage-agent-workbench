---
name: storageops-triage
description: >
  First-contact triage for any object-storage issue with no clear category.
  Classify the problem domain (permission, performance, protocol/signature,
  network/TLS, cost/lifecycle, mount, CLI/SDK, bigdata, consistency,
  notification, replication, migration), gauge severity and evidence, then load
  the matching specialist skill. Use this first when a user reports an
  S3/BOS/OSS/COS/GCS error without an obvious domain.
domains: [triage]
trigger_keywords:
  - object storage
  - S3 error
  - storage issue
  - bucket issue
  - BOS
  - OSS
  - COS
  - GCS
---

# Triage — First-Contact Classification

Classify the problem, then hand off to the right specialist skill. Do NOT attempt
the deep diagnosis here — load the specialist method and follow it.

## Decision tree

```
User reports a storage issue →
  ├─ Has an error code / HTTP status? → classify by signature
  │   ├─ 403 AccessDenied / 401 Unauthorized       → storageops-security-iam-policy
  │   ├─ 429 / 503 SlowDown, slow, timeout          → storageops-performance-diagnosis
  │   ├─ SignatureDoesNotMatch / 400 / CORS         → storageops-s3-protocol-compatibility
  │   ├─ Connection refused / DNS / TLS / cert      → storageops-network-endpoint-access
  │   ├─ SDK/CLI exception (boto3, awscli, rclone)  → storageops-cli-sdk-diagnosis
  │   ├─ Spark / Hive / Hadoop / S3A                → storageops-bigdata-pipeline
  │   ├─ Event missing / Lambda not triggered       → storageops-event-notification
  │   └─ Replication lag / version / DeleteMarker   → storageops-replication-versioning
  ├─ Cost / billing / storage-class complaint        → storageops-lifecycle-cost
  ├─ Mount / FUSE / s3fs complaint                    → storageops-mount-filesystem-workspace
  ├─ Stale read / missing object / ETag mismatch      → storageops-data-consistency
  ├─ Migration / cross-cloud sync question            → storageops-migration-sync
  ├─ Access-log / traffic / who-is-accessing question → storageops-access-log-analysis
  └─ No usable evidence → ask clarifying questions; do NOT guess the domain
```

## Investigate with your read-only tools

Before routing, confirm the basics cheaply so the specialist starts from facts:

- `test_credentials` — are the provider's keys valid at all? (separates an auth
  failure from a specific permission/signature problem)
- `list_buckets` / `head_bucket` — is the account reachable and the bucket
  present? Narrow "everything is broken" down to a single layer.
- Note the provider type (AWS / BOS / OSS / COS / GCS / R2 / B2). Most
  misdiagnosis comes from applying AWS assumptions to a non-AWS provider — carry
  the real provider into the specialist skill.

Then call `read_skill("storageops-<domain>")` to load the specialist method and
follow it.

## Severity

| Severity | Criteria |
|----------|----------|
| critical | Production data loss, security exposure, complete outage |
| high     | Major performance degradation or partial outage |
| medium   | Isolated errors, a workaround exists |
| low      | Cosmetic, informational, or planning question |

## Ask the user (only what tools can't reveal)

1. The exact error message / HTTP status code (full XML/JSON if available).
2. The tool + version (awscli, boto3, rclone, s5cmd, SDK).
3. Timeline: when did it start; persistent or intermittent?

If evidence is still insufficient after one clarifying round, say which specific
items would let you route confidently rather than guessing.

## What to report

A one-line classification, the primary domain (with confidence) and severity,
the few tool-verified facts you established, and which specialist skill you are
applying next. If the symptom spans two domains, name both in priority order.
