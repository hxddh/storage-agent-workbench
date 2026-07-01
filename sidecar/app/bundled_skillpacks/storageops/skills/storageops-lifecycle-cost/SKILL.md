---
name: storageops-lifecycle-cost
description: >
  Diagnose why object-storage cost is higher than expected and recommend
  lifecycle/storage-class strategy. Covers small-file billing-floor overhead,
  objects in the wrong tier, accumulating noncurrent versions, orphaned
  incomplete multipart uploads, and transition/minimum-duration rules. Use for
  billed-storage and tiering questions (not transfer speed). Treat class
  thresholds, minimum durations, and prices as provider-specific until confirmed.
domains: [lifecycle, cost]
trigger_keywords:
  - lifecycle
  - cost
  - billing
  - storage class
  - Glacier
  - IA
  - Intelligent Tiering
---

# Lifecycle & Cost Analysis

Most cost surprises come from minimum-duration penalties, small files (each
object is separately billable, often with a size floor), accumulating versions,
and orphaned multipart parts. The transfer-speed small-file penalty belongs to
`storageops-performance-diagnosis`; log-derived request cost belongs to
`storageops-access-log-analysis`.

## Decision tree

```
Cost concern →
  ├─ "bill too high" →
  │   ├─ many small files?        → billing-floor amplification
  │   ├─ wrong tier (IA accessed often)? → retrieval fees outweigh storage savings
  │   ├─ versioning on?            → every noncurrent version is billable
  │   └─ incomplete multipart?      → orphaned parts billed until aborted
  ├─ "what lifecycle rules?" →
  │   ├─ known access pattern?     → manual transitions matched to minimum durations
  │   └─ unknown pattern?           → intelligent-tiering (auto-move)
  └─ no data → gather inventory: object count, size distribution, class breakdown
```

## Investigate with your read-only tools

- `review_bucket_lifecycle` — read the bucket's current lifecycle rules and
  versioning/cleanup posture; surfaces missing "abort incomplete multipart" and
  risky early transitions.
- `review_bucket_cost_optimization` — the cost-focused review: flags wrong-tier
  data, small-object overhead, and version accumulation.
- `list_object_versions` — when config shows versioning on but the bill is
  unexplained, this reads the ACTUAL pileup (noncurrent-version count + bytes,
  delete markers) that the config review can't see. The concrete "your bucket is
  huge because of old versions" evidence.
- `list_multipart_uploads` — surfaces abandoned incomplete uploads whose parts
  are billed but invisible in a normal listing. If present, propose an "abort
  incomplete multipart upload" lifecycle rule (manual — the app never aborts).
- `review_bucket_performance_profile` / `list_objects` — sample size
  distribution and storage classes to judge small-file impact.
- Run `review_bucket_config` (inline, read-only) for the full lifecycle posture.
  For real per-object numbers, analyze an uploaded inventory export with
  `analyze_uploaded_file`; for an inventory still in a bucket, propose
  `plan_inventory_import` (a confirmed import). Do not invent prices.

## Ask the user (only what tools can't reveal)

- Per-bucket / per-class billing data (to calibrate any savings estimate).
- The lifecycle XML currently applied, if they want it audited.
- Whether versioning is on and roughly how many noncurrent versions exist.

## What to report

Where the cost goes (storage floor / wrong tier / versions / orphaned parts), a
lifecycle recommendation matched to minimum-duration rules (manual-only — it
affects all matching objects, and noncurrent versions if versioning is on), and
an explicit note that storage-class estimates exclude request and transfer cost
unless access logs are analyzed. State which numbers are tool-verified vs.
provider-pricing assumptions.
