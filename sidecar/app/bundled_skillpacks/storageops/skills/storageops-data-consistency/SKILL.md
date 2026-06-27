---
name: storageops-data-consistency
description: >
  Diagnose "stale read", "missing object after write", ETag confusion, and
  concurrent-overwrite problems. Modern object storage (S3, BOS, OSS, COS, GCS)
  is strongly consistent for core ops, so the cause is almost always client-side
  — caching, an incomplete multipart upload, ETag misreading, or last-writer-wins
  races. Use for visibility/staleness; replication/version divergence go elsewhere.
domains: [consistency]
trigger_keywords:
  - consistency
  - stale read
  - mismatch
  - ETag
  - checksum
  - missing object
---

# Data Consistency Diagnosis

Object storage is strongly consistent for core read-after-write today, so a
genuine "eventual consistency" bug is rare. Look client-side first: caches, an
uncompleted multipart upload, ETag format confusion, or concurrent writers.

## Decision tree

```
Consistency concern →
  ├─ wrote but can't read →
  │   ├─ multipart: CompleteMultipartUpload actually called? (else object doesn't exist)
  │   ├─ read via a different client/CDN? → that layer's cache
  │   └─ read via a mount? → mount cache not invalidated → storageops-mount-filesystem-workspace
  ├─ see old data after overwrite → browser/CDN/app cache TTL or ETag validation
  ├─ object overwritten unexpectedly → concurrent writers, last-writer-wins → enable versioning
  ├─ LIST missing new objects → wrong prefix, pagination, or directory-marker (LIST is consistent)
  └─ ETag changed unexpectedly → multipart vs single-part, or SSE-KMS key
```

## Investigate with your read-only tools

- `head_object` — the key probe: read the object's ETag, size, last-modified, and
  storage class. Compare the live ETag to what the client cached to prove staleness
  is client-side, and classify the ETag (single-part MD5 vs multipart `-N`).
- `list_objects` — confirm the object/prefix is actually present (LIST is
  consistent), ruling out "wrong prefix" and pagination illusions.
- `test_range_get` — confirm the current bytes are readable directly from the
  store, separating real object state from a stale cache.

## Ask the user (only what tools can't reveal)

- The exact timeline: upload start, CompleteMultipartUpload, first read, stale
  observation — against the client clock.
- Which cache layers sit in front (SDK/VFS, app cache, CDN, browser) and their TTLs.
- Whether multiple clients write the same key.

## What to report

That the store itself is consistent (shown via `head_object`/`list_objects`) and
which client-side layer is stale (or that a multipart upload never completed),
the fix (cache invalidation / complete the upload / enable versioning for
races), and how to confirm — re-`head_object` and compare ETag/last-modified.
