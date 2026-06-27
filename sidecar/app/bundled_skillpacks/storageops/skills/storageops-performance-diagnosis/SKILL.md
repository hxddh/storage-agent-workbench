---
name: storageops-performance-diagnosis
description: >
  Diagnose object storage throughput and latency issues. Covers throttling
  (429/503), slow upload/download, multipart inefficiency, small-file overhead,
  prefix hotspotting, and connection pool exhaustion. Use when user reports
  slow transfers, rate limiting, or throughput below expected bandwidth.
  Triggered by 429 SlowDown, 503 SlowDown, timing data, or performance complaints.
maturity: core
mode: light_heavy
estimated_tokens: 1400
trigger_keywords:
  - 429 SlowDown
  - 503 SlowDown
  - slow upload
  - slow download
  - throughput
  - performance
  - throttling
  - rate limit
  - multipart
  - concurrency
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
  - capture_http_trace
---

# Performance Diagnosis

Identify the bottleneck layer (client, network, service-side throttling), then apply targeted tuning. All recommendations are manual-only unless labeled safe.

> **Scope boundary:** this skill owns general 429/SlowDown throttling. `storageops-cli-sdk-diagnosis` only covers tool-version-specific 429 behavior (e.g. an SDK default), so route service-side rate limiting here.

## Decision Tree

```
Slow transfer / 429/503 error →
  ├─ Has 429/503? → Throttling path
  │   ├─ Steady 429 from start? → Reduce concurrency (`references/throttling.md`)
  │   ├─ Sudden 429 after N requests? → Rate limit burst → Add jitter + backoff
  │   └─ 503 only? → Service-side overload → Reduce workers, spread prefix
  ├─ No 429/503 but slow? → Non-throttling path
  │   ├─ Many small files (<1MB)? → Small-file overhead (`references/small-files.md`)
  │   ├─ Few large files (>100MB)? → Multipart tuning (`references/multipart-tuning.md`)
  │   ├─ Many files in same prefix? → Hotspot (`references/prefix-hotspot.md`)
  │   └─ Normal workload, just slow? → Network or client bottleneck
  └─ Insufficient data? → Request timing breakdown (`references/throughput-model.md`)
```

## Workflow

### Step 1: Characterize the Workload
From the evidence, determine: file count, average file size, total data volume, operation type (PUT/GET/LIST/DELETE), and concurrency level.

### Step 2: Identify the Bottleneck Layer
Cross-reference error codes, timing data, and workload profile:
- **Client-side**: CPU at 100%, insufficient file descriptors, single-threaded
- **Network**: latency >100ms RTT, packet loss, bandwidth saturation
- **Service-side**: 429/503 errors, request latency spikes without client/network changes

See `references/throughput-model.md` for expected throughput by workload type.

If the user lacks timing/status evidence and a small read-only probe is enough,
use `capture_http_trace` to capture request count, status, and rough timing for
one bounded command. Do not use it for bulk transfers, uploads, downloads, sync,
or body capture.

### Step 3: Apply Targeted Tuning
- **Throttling (429)**: Reduce concurrency, add exponential backoff with jitter. See `references/throttling.md`. To turn a detected throttle rate into a concrete concurrency/backoff recommendation, run `python3 scripts/throttle_tuning_recommender.py --throttle-rate <r> --concurrency <n> [--provider <p>]`.
- **Small files**: batch operations, increase parallel connections, consider archive-and-compress. See `references/small-files.md`.
- **Large files**: tune multipart size and concurrency. See `references/multipart-tuning.md`.
- **Prefix hotspot**: spread objects across prefixes. See `references/prefix-hotspot.md`.
- **Network**: check MTU, TCP window, proxy overhead.

### Step 4: Validate
Suggest safe read-only validation: retry with `--dry-run`, measure improved throughput with reduced concurrency, check if error rate drops.

### Step 5: Feedback Loop
If `scripts/throttle_detector.py` is available, run `python3 scripts/throttle_detector.py --file <log>` to confirm findings. If confidence < medium after diagnosis, go back to Step 1 and ask the user: *"Can you provide timing breakdown per file (use --stats in rclone, or --log debug in s5cmd)?"*

## User Interaction

### When to ask the user:
- *"What tool and version are you using?"*
- *"Can you run with --verbose/--debug and share the first 50 lines of error output?"*
- *"What is the approximate object count and total size?"*

### When to inform the user:
- Before recommending any tool: *"I recommend running <tool> with <flags>. This is non-destructive."*
- After diagnosis: *"Please validate this fix in a staging environment before applying to production."*

## Output Contract — include these fields

```markdown
## Summary
[one-line diagnosis]
**Route**: storageops-performance-diagnosis
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[client|network|service-throttling|multipart|small-files|prefix-hotspot], affected_layer=[client|network|provider|workload]

## Key Evidence
- Error codes: [list with count]; timing profile: [TTFB, transfer rate, concurrency]
- Workload: [file count × avg size = total]
- What's happening and why it causes the symptom: [finding]

## Remediation
1. **[action]** (manual-only | safe) — [expected effect]
2. ...
- Validation: [read-only or low-risk experiment that can confirm the bottleneck]

## What Would Falsify This
- [evidence that would make the diagnosis unlikely]

## Risks / Open Questions
- [missing data, production risk, provider limits to confirm]
```

## Examples

### Example 1: s5cmd 429 SlowDown on sync
**Input**: s5cmd sync, 10 workers, 500K small files. Error: `SlowDown (429)` on 3% of requests.
**Diagnosis**: Throttling from excessive concurrency on small-file workload  
**Recommendation**: `--concurrency 5 --retry-count 10` (reduce workers by 50%), expect 429 rate <0.5%

### Example 2: rclone upload slow, no errors
**Input**: rclone copy 50GB file to BOS at 8 MB/s (1 Gbps link available), no errors.
**Diagnosis**: Multipart under-tuned — single-part upload with no parallelism  
**Recommendation**: `--s3-upload-concurrency 8 --s3-chunk-size 64M`, expect 40-60 MB/s

### Example 3: Spark job slow, no errors
**Input**: Spark write to S3, 2000 tasks, each writing 10KB. Job takes 45 min.
**Diagnosis**: Small-file overhead — 2000 LIST/PUT rounds  
**Recommendation**: Coalesce to 100 partitions before write, use S3A committer, expect <10 min

## References
- `references/throttling.md` — 429/503 patterns, backoff strategies, and per-provider concurrency/rate limits | **Read when:** user reports 429/503/SlowDown/Throttling errors or is hitting rate limits on a specific cloud provider
- `references/small-files.md` — Metadata amplification, batching | **Read when:** workload contains many files <1MB
- `references/multipart-tuning.md` — Chunk size, concurrency, provider quirks | **Read when:** user is uploading/downloading files >100MB
- `references/prefix-hotspot.md` — Key distribution and request rate partitioning | **Read when:** many files share the same prefix and throughput is below expected
- `references/throughput-model.md` — Expected throughput formulas | **Read when:** user provides timing data and asks why throughput is low
- `references/performance-benchmarks.md` — Order-of-magnitude throughput/RPS reference by scenario (verify non-AWS rows against the provider) | **Read when:** you need a rough baseline to judge whether observed numbers are anomalous
- `scripts/throttle_tuning_recommender.py` — Deterministic concurrency/backoff recommender from an observed throttle rate | **Run when:** throttling is confirmed and the user asks what concurrency/backoff to use
