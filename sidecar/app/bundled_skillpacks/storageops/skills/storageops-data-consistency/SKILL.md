---
name: storageops-data-consistency
description: >
  Diagnose data consistency concerns on object storage. Covers stale reads
  (cache/ETag mismatch), concurrent write conflicts, multipart upload
  consistency, and directory listing eventual consistency scenarios.
  Modern object storage is strongly consistent for read-after-write on
  PUTs and DELETEs. Consistency issues usually stem from: client-side
  caching, ETag format discrepancies, CDN/edge caching, or concurrent
  multi-client write races. Use when user reports stale data, missing
  objects after write, or conflicting object versions.
maturity: mature
mode: light_heavy
estimated_tokens: 1100
trigger_keywords:
  - stale data
  - not seeing latest version
  - missing object after upload
  - eventual consistency
  - strong consistency
  - ETag mismatch
  - cache consistency
  - concurrent write
  - object overwritten
  - data integrity
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
---

# Data Consistency Diagnosis

Object storage (AWS S3, BOS, OSS, COS, GCS) has been **strongly consistent** for core operations since ~2020. If user reports "eventual consistency" issues, the root cause is almost always client-side: caching, ETag confusion, or concurrent write races.

> **Scope boundary:** this skill owns ETag/stale-read/cache-coherence and concurrent-write semantics. `storageops-replication-versioning` owns versioning and cross-region/replication state; `storageops-s3-protocol-compatibility` owns signature and protocol-level mismatches. Route version/replica divergence and protocol/signature errors to those skills.

## Decision Tree

```
Consistency concern →
  ├─ "I wrote an object but can't read it" →
  │   ├─ Same client, same key? → Check: upload completed? Multipart CompleteMultipartUpload called?
  │   │   └─ Multipart upload → Parts uploaded but CompleteMultipartUpload NOT called → object doesn't exist yet
  │   ├─ Write via client A, read via client B? → Check: client B cache, CDN edge
  │   └─ Write via SDK, read via mount? → Mount cache not invalidated (Step 2)
  ├─ "I see old version after overwrite" →
  │   ├─ Browser/CDN? → Cache-Control header, CDN TTL, ETag validation
  │   ├─ Application cache? → In-memory cache, local disk cache
  │   └─ Mount? → rclone/s3fs dir-cache-time not expired (Step 2)
  ├─ "Object was overwritten unexpectedly" →
  │   └─ Concurrent writes from multiple clients → Last writer wins (no locking). Enable versioning.
  ├─ "LIST is missing newly created objects" →
  │   └─ LIST is strongly consistent. Likely: wrong prefix, hidden by pagination, or directory marker issue
  └─ "ETag changed without my changes" → System-managed key rotation (SSE-KMS/SSE-C)
```

## Workflow

### Step 1: Reconstruct Timeline
Get timestamps: upload start, upload completion (CompleteMultipartUpload), first read attempt, observed stale data time. Compare to system clock.

### Step 2: Identify Cache Layers
- **Client-side SDK cache**: boto3/botocore credential cache, rclone VFS cache, s3fs stat cache
- **Application cache**: in-memory object store, local file cache, CDN
- **Mount cache**: rclone `--dir-cache-time`, `--attr-timeout`, s3fs `stat_cache_expire`
- **CDN cache**: CloudFront, CDN vendor, browser cache

### Step 3: Check ETag Format
Run `python3 scripts/etag_parser.py <etag> [<etag2> ...] --pretty` (or `--stdin`)
to classify each ETag deterministically — single-part MD5 vs multipart, AWS
trailing `-N` vs BOS leading-dash, and SSE/KMS hints — then reason over the
result instead of eyeballing the string.
- Single-part upload ETag = MD5 of file content
- Multipart upload ETag = MD5 of (concatenated binary MD5s of parts) + `-N` (part count suffix on AWS)
- **BOS uses different ETag format** for multipart — may cause checksum mismatch on cross-provider copy
- SSE-KMS changes ETag — NOT the MD5 of the object

When a multipart ETag "changed" after a copy/migration but the bytes look
identical, the usual cause is **re-chunking** (a different part size on each side).
Run `python3 scripts/multipart_etag_calculator.py --total-size <bytes> --observed-etag <hex>-N [--other-part-size <bytes>]`
to recover the source part-size band and confirm deterministically whether the
destination's part size reproduces the ETag — distinguishing a re-chunk from real
corruption. With a part list, compute the ETag directly via `--part-md5s <file>`.

### Step 4: Concurrent Write Analysis
Object storage has no write locking. Two simultaneous PUTs to the same key = last writer wins. For multi-client scenarios, recommend: versioning + conditional writes (If-None-Match header).

### Step 5: Verify with Direct Head
Recommend user perform a direct `HEAD` request to confirm object state:
```bash
curl -I https://<endpoint>/<bucket>/<key>
# Check: Last-Modified, ETag, Content-Length
```

### Step 6: Feedback Loop
If the root cause is still unclear after Step 5:

- **Request timeline** from the user: "Can you provide the exact timestamps of: (1) upload start, (2) upload completion, (3) first read attempt, (4) when stale data was first observed?"
- **If confidence < medium**: Go back to **Step 2** and ask: "Can you describe the exact sequence of operations that led to the inconsistent state? Were any operations concurrent across multiple clients?"
- **Re-verify**: After each recommendation, suggest the user run `curl -I https://<endpoint>/<bucket>/<key>` to confirm the fix took effect.

## User Interaction

### When to ask the user:
- "Which object key and bucket are you experiencing the issue with?"
- "What tool/CLI/SDK are you using to access the storage?"
- "Is there a CDN, cache layer, or mount between your application and the object storage?"
- "Have you tried a direct HEAD request to the object?"
- "Were any uploads concurrent from multiple clients?"

### When to inform the user:
- "Modern object storage (S3/BOS/OSS/COS/GCS) is strongly consistent for read-after-write since ~2020. Consistency issues are almost always client-side."
- "Multipart uploads are NOT objects until CompleteMultipartUpload is called."
- "Last writer wins — if two clients write to the same key simultaneously, there is no locking."

## Output Contract — include these fields

```markdown
## Summary
[one-line diagnosis]
**Route**: storageops-data-consistency
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[client-cache|mount-cache|cdn-cache|multipart-not-completed|concurrent-write|etag-format|sse-kms-etag], affected_layer=[client|mount|cdn|object-store]

## Key Evidence
- Timeline: write [ts] → read attempt [ts] → stale observed [yes/no, ts]
- Cache layers identified: [layer] — [TTL state]
- Explanation with evidence: [finding]

## Remediation
1. **[fix]** — [cache invalidation, versioning enable, conditional write pattern]

## What Would Falsify This
- [evidence that would make the diagnosis unlikely]

## Risks / Open Questions
- [missing timeline data, production risk, provider-specific caveat]
```

## Examples

### Example 1: Mount cache showing stale data
**Input**: rclone mount, file updated via S3 console. `ls -la` still shows old file size.
**Diagnosis**: rclone dir-cache not expired. Default `--dir-cache-time 5m`, file updated 2 min ago.
**Recommendation**: Wait for cache expiry, or `kill -SIGHUP $(pgrep rclone)` to flush cache. For production: reduce `--dir-cache-time` or use `--vfs-cache-mode full`.

### Example 2: Multipart upload never completed
**Input**: "Uploaded 10GB file, but object doesn't appear in bucket listing."
**Diagnosis**: Parts uploaded successfully, but `CompleteMultipartUpload` API call failed or was never made. Parts exist but no object.
**Recommendation**: Call `CompleteMultipartUpload` or `AbortMultipartUpload`. Add lifecycle rule to abort incomplete multipart uploads after 7 days.

### Example 3: CDN caching old version
**Input**: Updated image on S3, website still shows old image 2 hours later.
**Diagnosis**: CDN (CloudFront) cached old version with `max-age=86400`. ETag not being invalidated.
**Recommendation**: CloudFront invalidation: `aws cloudfront create-invalidation --distribution-id <ID> --paths /path/to/image.jpg`. Long-term: use versioned filenames or shorter Cache-Control.

## What Would Falsify This
- A direct `HEAD` (bypassing every cache/CDN/mount) already returns the latest `Last-Modified`/`ETag`/`Content-Length`, so the stale read lives in a client layer, not the object store.
- The object's `ETag` carries a multipart `-N` suffix or SSE-KMS markers (`etag_parser.py`), explaining a "checksum changed" report without any actual data divergence.
- The two readers hit the same single client with no CDN, mount, or second writer in the path, ruling out CDN-TTL and concurrent-write (last-writer-wins) hypotheses.

## Risks / Open Questions
- Without precise timestamps for upload start, `CompleteMultipartUpload`, and first read, a multipart-not-completed vs cache-staleness call stays uncertain.
- Object storage has no write locking, so a hidden concurrent writer can silently invalidate the diagnosis — confirm whether versioning was enabled to recover prior state.
- BOS multipart ETag shape differs from AWS and SSE-KMS rewrites the ETag; cross-provider copy checks need `references/etag-format.md` to avoid false "corruption" conclusions.

## References
- `scripts/etag_parser.py` — Offline ETag classifier (single-part/multipart, AWS vs BOS shape, SSE hints) | **Read when:** you have one or more ETags and need to confirm the upload type or a cross-provider format mismatch
- `scripts/multipart_etag_calculator.py` — Compute/verify a multipart ETag from part MD5s, or reverse the part-size band from `--total-size` + observed `<hex>-N` | **Run when:** a multipart ETag "changed" after copy/migration though the bytes look identical (re-chunking vs corruption)
- `references/cache-layers.md` — Complete cache layer inventory across SDK, mount, CDN | **Read when:** user reports stale reads, outdated data, or mount filesystem inconsistencies
- `references/etag-format.md` — ETag formats by upload type and provider | **Read when:** user mentions ETag mismatch, checksum errors, or cross-provider copy with corrupted files
- `references/multipart-consistency.md` — Multipart upload lifecycle and consistency | **Read when:** user reports objects not appearing after large upload, or incomplete multipart uploads consuming storage
- `references/concurrent-writes.md` — Lock-free object storage write semantics | **Read when:** user reports objects being overwritten unexpectedly, or race conditions between multiple uploaders
- `references/cdn-invalidation.md` — CDN cache invalidation patterns | **Read when:** user reports stale content via browser/CDN, updated files not reflecting, or caching TTL concerns
