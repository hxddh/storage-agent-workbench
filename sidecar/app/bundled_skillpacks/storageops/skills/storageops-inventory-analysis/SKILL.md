---
name: storageops-inventory-analysis
description: >
  Read an object-storage inventory to understand capacity and object-shape:
  total size and object count, size distribution, which prefixes hold the bytes,
  storage-class mix, small-object ratio, and the largest objects. Use when the
  user asks how big a bucket is, how objects are distributed, where capacity goes,
  or whether there are too many small files. Cost/lifecycle decisions go to the
  lifecycle skill; throughput effects go to the performance skill.
domains: [inventory, capacity]
trigger_keywords:
  - inventory
  - capacity
  - bucket size
  - object count
  - storage class
  - small files
  - prefix distribution
  - largest objects
---

# Inventory & Capacity Analysis

Turn an inventory into a factual picture of *what the data looks like* — how much,
how it's shaped, and where the bytes are. This is the fact layer; "why it costs"
and "what rule to set" belong to `storageops-lifecycle-cost`, and throughput
effects to `storageops-performance-diagnosis`.

## Decision tree

```
Inventory question →
  ├─ "how big / how is it distributed?" → object_count, total_size,
  │     average_object_size, size_histogram
  ├─ "where is the capacity?"            → prefix_distribution (top prefixes by size)
  ├─ "too many small files?"            → small_object_ratio + size_histogram
  │     (high ratio → compaction / write-pattern review → performance skill)
  ├─ "is the storage class right?"      → storage_class_distribution
  │     (→ lifecycle-cost for the tiering/cost decision)
  └─ "what are the biggest objects?"    → top_large_objects, object_age_distribution
```

## How this runs in the app

Two paths, depending on where the inventory lives:

- **A file the user attached** — analyze it inline, now: call `list_uploaded_files`
  first to get the actual `dataset_id` attached to this session (don't assume
  one), then `analyze_uploaded_file` on it (it ingests CSV/Parquet and computes
  the metrics above over the local file) and explain the result conversationally.
  No confirmation.
- **Inventory still in a bucket** — bringing it in is cloud-side data movement, so
  it stays a confirmed step: propose `plan_inventory_import`. After the user
  confirms and the run completes, read its findings; if it finished in the
  background, pick the result back up with `read_run_result(run_id)` rather than
  re-importing.

Use judgement about which metrics matter for the question — you don't need every
one. Hand cost/tiering decisions to `storageops-lifecycle-cost` and small-object
throughput effects to `storageops-performance-diagnosis`.

## Ask the user (only what tools can't reveal)

- The inventory format/source (S3 Inventory CSV/Parquet, a manifest, or an ad-hoc
  listing) — ORC isn't supported, CSV/Parquet are.
- Whether this is a single snapshot or a series — growth/forecasting needs more
  than one point in time; a single inventory describes *now*, not a trend.
- Which prefixes or workloads matter, if the bucket mixes several.

## What to report

The capacity picture grounded in the analysis (object count, total and average
size, the size-bucket spread, the top prefixes by size, the storage-class mix, the
small-object ratio, and the largest objects), clearly separating what the
inventory shows from inference, plus a hand-off to the cost or performance skill
for any decision. If the inventory is a partial/sample listing, say so rather than
implying it's the whole bucket.
