---
name: storageops-performance-diagnosis
description: >
  Diagnose object-storage throughput and latency problems — throttling (429/503
  SlowDown), slow upload/download, multipart inefficiency, small-file overhead,
  prefix hotspotting, connection-pool exhaustion. Use when transfers are slow or
  rate-limited, or throughput is far below the available bandwidth.
domains: [performance]
trigger_keywords:
  - 429 SlowDown
  - 503 SlowDown
  - slow upload
  - slow download
  - throughput
  - throttling
  - rate limit
  - multipart
---

# Performance Diagnosis

Find the bottleneck layer — client, network, or service-side throttling — then
recommend targeted, manual-only tuning. This skill owns general 429/SlowDown
throttling; tool-version-specific quirks belong to
`storageops-cli-sdk-diagnosis`.

## Decision tree

```
Slow transfer or 429/503 →
  ├─ 429/503 present? → throttling path
  │   ├─ 429 from the start         → concurrency too high; reduce workers
  │   ├─ 429 after a burst           → add exponential backoff + jitter
  │   └─ 503 only                     → service overload; spread across prefixes
  ├─ Slow, no errors? → bottleneck path
  │   ├─ Many small files (<1 MB)     → metadata/round-trip overhead; batch
  │   ├─ Few large files (>100 MB)    → multipart size/concurrency under-tuned
  │   ├─ Many keys in one prefix       → hot prefix; spread the key space
  │   └─ Otherwise                      → network (RTT, window, proxy) or client CPU
  └─ Insufficient timing data → ask for a per-request timing breakdown
```

## Investigate with your read-only tools

- `list_objects` (bounded) — sample the key layout to judge small-file vs
  large-file vs hot-prefix workload.
- `review_bucket_performance_profile` — profile object sizes / storage classes /
  key distribution for a bucket; for the full picture run `review_bucket_config`
  (inline, read-only).
- `test_range_get` — measure first-byte latency and confirm ranged reads work
  (relevant for partial-read / CDN-origin workloads).
- `inspect_endpoint_tls` / `test_addressing_style` — rule out a handshake or
  addressing cost masquerading as "slowness".

For traffic-shaped throughput/error analysis over time, analyze an attached log
with `analyze_uploaded_file`, or for logs still in a bucket propose
`plan_access_log_import` (a confirmed import) — rather than guessing from a
snapshot.

## Ask the user (only what tools can't reveal)

- Tool + version and the exact command (concurrency, chunk size flags).
- Object count and average size; link bandwidth and rough RTT to the endpoint.
- A verbose/debug timing sample (e.g. rclone `--stats`, s5cmd debug log).

## What to report

The bottleneck layer (client / network / service-throttling / multipart /
small-files / prefix-hotspot), the concrete tuning (concurrency, backoff, chunk
size, key spreading) marked manual-only, expected effect, a read-only way to
validate (lower concurrency → error rate drops; tuned multipart → higher MB/s),
and what evidence would falsify it.
