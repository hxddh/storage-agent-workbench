---
name: storageops-replication-versioning
description: >
  Diagnose replication and versioning problems — objects not replicating,
  delete markers not propagating, replication lag, versioning state confusion,
  and object-lock/retention behavior. Use for "my replica is missing/stale" or
  unexpected version state. Read-after-write visibility belongs to the
  data-consistency skill; version storage cost belongs to the lifecycle skill.
domains: [replication]
trigger_keywords:
  - replication
  - versioning
  - CRR
  - SRR
  - DeleteMarker
  - Object Lock
  - retention
---

# Replication & Versioning Diagnosis

Replication failures fall into configuration (rule doesn't match), operation
(replication failing/lagging), and versioning-state surprises. The three
prerequisites for replication: versioning on BOTH buckets, a matching rule on the
source, and a role with replicate permissions.

## Decision tree

```
Replication / versioning issue →
  ├─ objects not replicating →
  │   ├─ rule filter (prefix/tag/status) actually matches?
  │   ├─ versioning enabled on source AND destination?
  │   ├─ replication role has replicate + (KMS) permissions?
  │   └─ object predates the rule? → not retroactive (needs a batch copy)
  ├─ delete markers not propagating → DeleteMarkerReplication must be enabled
  ├─ replication lag → backlog / cross-region latency / large objects ÷ bandwidth
  ├─ object lock not working → must be enabled at bucket creation; COMPLIANCE can't be overridden
  └─ version-id surprises → Enabled vs Suspended state machine (suspended → null version ids)
```

## Investigate with your read-only tools

- `review_bucket_security` / `get_bucket_config_summary` — read versioning state
  and (where the provider exposes it) replication/object-lock configuration on
  the source and destination buckets; mismatched versioning is the #1 cause.
- `head_object` — inspect a specific object's version/metadata to confirm whether
  it exists on the destination and its state. Its `replication_status`
  (PENDING / COMPLETED / FAILED / REPLICA) answers "did this object replicate /
  is it a replica?" directly, and `version_id` (with the `version_id` arg) lets
  you HEAD a SPECIFIC version to compare current vs noncurrent.
- `get_bucket_config_detail` (aspect `replication`) — the actual per-rule status,
  prefix/tag filter, delete-marker replication, and destination bucket, so you
  read the replication config instead of asking for it.
- `get_object_attributes` — checksum + part count when confirming a replicated
  object matches the source byte-for-byte (provider_unsupported → head_object).
- `get_object_lock_status` — when the confusion is "why can't I delete/overwrite
  this object?", this reads the OBJECT's actual retention mode + retain-until date
  and legal-hold status (COMPLIANCE can't be shortened; a legal hold blocks delete
  regardless of retention). For the BUCKET's WORM default — is object-lock enabled
  and what default retention mode/days/years applies to new objects —
  `get_bucket_config_detail` (aspect `object_lock`) reads it directly; the two
  together explain "every new object is undeletable for N days".
- `list_object_versions` — when the confusion is about version STATE (unexpected
  noncurrent versions, lingering delete markers not propagating), this reads the
  actual versions + delete markers on a prefix, not just the on/off config.
- `list_objects` — compare a prefix sample between source and destination buckets
  (add both as providers/buckets) to localize what's missing.
- Run `review_bucket_config` (inline, read-only) for a thorough posture check
  per bucket.

## Ask the user (only what tools can't reveal)

- The replication rule JSON and both buckets' versioning state.
- Whether failing objects predate the rule, and whether objects are KMS-encrypted
  (the replication role then also needs key access).
- For object lock: was it enabled at bucket creation, and which retention mode?

## What to report

The failure class (rule-filter / dest-versioning / role-permission / not-
retroactive / delete-marker / lag), grounded in the config you could read vs.
what the user must supply, the fix (manual-only), and how to verify — e.g. re-
checking versioning via `get_bucket_config_summary` and comparing a `head_object`
on both sides.
