---
name: storageops-access-log-analysis
description: >
  Analyze object-storage server access logs for error patterns, traffic
  profiles, anomaly spikes, hot keys, and request-cost attribution. Use when the
  user asks who/what is hitting a bucket, why error rates changed over time, or
  where request cost comes from. Permission root-cause goes to the security
  skill; storage-class cost goes to the lifecycle skill.
domains: [access-log, observability]
trigger_keywords:
  - access log
  - error rate
  - 403 spike
  - 503 spike
  - traffic analysis
  - hot keys
  - who is accessing
---

# Access Log Analysis

Turn raw access logs into traffic, error, and cost patterns. Log formats differ
by provider (AWS space-delimited, BOS/COS CSV, OSS JSON/Log Service), so confirm
the format from a sample line first.

## Decision tree

```
Access-log question →
  ├─ "why these 4xx/5xx errors?" →
  │   ├─ one IP/key?  → credential/permission misconfig → storageops-security-iam-policy
  │   ├─ many sources? → bucket policy / public ACL → storageops-security-iam-policy
  │   └─ rising over time? → rotated/expired credential
  ├─ "who is accessing?" → `aggregate_uploaded_file` grouped by client_ip_masked
  ├─ "where is cost coming from?" → count operations by type + bytes per requester → storageops-lifecycle-cost
  └─ "unusual activity?" → request-rate spikes vs baseline, first-seen requesters, off-hours
```

## How this runs in the app

Two cases, depending on where the logs live:

- **A log file the user attached** — analyze it inline, right now: call
  `list_uploaded_files` first to get the `dataset_id` of what's actually attached
  (don't assume one), then `analyze_uploaded_file` on it (it imports + computes
  error rates, status/method mix, top keys/prefixes/user-agents, requests-by-hour
  over the local file) and explain the result conversationally. No confirmation
  step. `analyze_uploaded_file` does NOT break down by requester — for "who is
  accessing", follow it with
  `aggregate_uploaded_file(dataset_id, metric='count', group_by='client_ip_masked')`
  (add `group_by_2='day'` for a trend, or `status_min`/`status_max` to isolate
  403s). Never label `top_user_agents` as requesters.
  If the result carries `"truncated": true`, the metrics cover only the first
  `rows_analyzed` rows — report them as a LOWER BOUND, not the whole file.
- **Logs still in a bucket** — this is cloud-side data movement, so it stays a
  confirmed step: propose `plan_access_log_import` to bring them in under a
  reviewed plan. Once the user confirms and the import run completes, read its
  findings; if it finished in the background, pick the result back up later with
  `read_run_result(run_id)` rather than re-importing.

Either way, route permission decisions to `storageops-security-iam-policy` and
cost decisions to `storageops-lifecycle-cost`.

You can use `list_objects` to help locate where logs are being delivered (e.g. a
`logs/` prefix) before proposing the import.

## Ask the user (only what tools can't reveal)

- Provider and where logs are delivered; a sample log line (first ~200 chars) so
  the format is unambiguous.
- The time window of interest and the baseline to compare a spike against.

## What to report

The traffic/error/cost pattern grounded in the analysis run (status-code mix,
hot keys, user agents, anomalies — plus a requester breakdown only if you
actually ran the aggregate), clearly separating what the logs show from
inference, and a hand-off to the security or cost skill for the decision.
