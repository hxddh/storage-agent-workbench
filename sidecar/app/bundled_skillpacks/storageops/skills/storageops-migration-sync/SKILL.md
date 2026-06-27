---
name: storageops-migration-sync
description: >
  Plan and validate object-storage migration and ongoing sync — same-provider
  server-side copy, cross-provider transfer (AWS↔BOS/OSS/COS/GCS), and large/
  offline transfers. Covers strategy selection by volume and bandwidth, egress
  cost, ETag/metadata/ACL compatibility, and post-migration integrity. Use for
  "how do I move/sync N TB between buckets/providers" questions.
domains: [migration]
trigger_keywords:
  - migration
  - sync
  - transfer
  - cross-cloud
  - 跨云
---

# Cross-Provider Migration & Sync

Pick a strategy by data volume, bandwidth, and provider compatibility, then
verify integrity. The migration itself runs in the user's own tooling — this app
is read-only — so the skill plans, sanity-checks compatibility, and helps verify.

## Decision tree

```
Migration →
  ├─ same provider + region?    → server-side copy (no egress, fastest)
  ├─ cross-provider <1TB         → direct client transfer (rclone)
  ├─ 1TB–100TB                    → parallel workers + bandwidth planning
  ├─ >100TB or thin link          → offline/appliance transfer
  ├─ ongoing (not one-time)       → scheduled rclone sync (delta only)
  └─ strict consistency           → verify every object checksum post-copy
```

## Investigate with your read-only tools

- `test_credentials` + `head_bucket` on **both** source and destination (add each
  as a provider) — confirm reachability and access before any transfer is planned.
- `test_addressing_style` — confirm the destination provider's addressing so the
  user's transfer tool is configured correctly (a top cause of cross-provider
  failures).
- `head_object` on a sample key on each side — compare ETag/metadata to catch the
  classic multipart-ETag format mismatch (AWS `-N` suffix vs BOS/OSS) before it
  breaks integrity checks.
- `list_objects` — compare object counts/keys on a prefix to scope the delta.
- Propose `run_inventory_analysis` (via `plan_inventory_import`) to size the
  migration (object count, total bytes, class mix) precisely.

## Ask the user (only what tools can't reveal)

- Source/destination providers + regions, time window, and downtime tolerance.
- Available bandwidth and egress-cost budget (cross-provider egress often
  dominates cost).
- Consistency requirement (sample-verify vs every-object checksum).

## What to report

The recommended strategy with a time/cost estimate (data ÷ effective throughput;
egress + request cost), the compatibility risks you verified (ETag format,
metadata limits, ACLs don't transfer), a dry-run plan on ~1000 objects, and a
post-migration integrity check (counts, total size, sample checksums). Mark every
transfer/verify command as something the user runs, not the app.
