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

- `head_object` — the key probe: read the object's ETag, size, last-modified,
  storage class, and now `replication_status` / `parts_count` /
  `cache_control` / `content_encoding`. Compare the live ETag to what the client
  cached to prove staleness is client-side, classify the ETag (single-part MD5 vs
  multipart `-N` — `parts_count` confirms it), and use `cache_control` to explain
  a client/CDN serving old bytes.
- `test_conditional_get` — the sharpest freshness probe: HeadObject with
  If-None-Match against the client's cached ETag. Read the verdict from
  `etag_matches`, NOT the raw status: **304 → unchanged** (the stale read is a
  cache/CDN problem, not the store); **200 with a DIFFERENT `current_etag` → it
  really changed**; **200 with the SAME ETag → the provider ignored If-None-Match**
  (`error_code="provider_unsupported"`) — that is unchanged plus a
  conditional-request capability gap, NOT a change, so don't report the object as
  modified. No body either way. Reach for this before asking the user about their
  cache layers.
- `get_object_attributes` — the object's checksum algorithm + part count when you
  need to diagnose a checksum/multipart-assembly mismatch (falls back to
  head_object where the provider doesn't implement it).
- `list_objects` — confirm the object/prefix is actually present (LIST is
  consistent), ruling out "wrong prefix" and pagination illusions.
- `test_range_get` — confirm the current bytes are readable directly from the
  store, separating real object state from a stale cache.
- `preview_object` — when "the content is wrong/old" for a text object, read a
  bounded, sanitized preview of its head to see the actual current bytes from the
  store (vs. what the client shows) — direct evidence of whether staleness is
  client-side. Text-only, per-turn budgeted; binary/oversized objects aren't decoded.

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
