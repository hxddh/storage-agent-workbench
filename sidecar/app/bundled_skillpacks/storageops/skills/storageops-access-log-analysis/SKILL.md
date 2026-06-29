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
  ├─ "who is accessing?" → aggregate by requester IP, principal, and operation
  ├─ "where is cost coming from?" → count operations by type + bytes per requester → storageops-lifecycle-cost
  └─ "unusual activity?" → request-rate spikes vs baseline, first-seen requesters, off-hours
```

## How this runs in the app

Two cases, depending on where the logs live:

- **A log file the user attached** — analyze it inline, right now: call
  `analyze_uploaded_file` (it imports + computes error rates, top
  requesters/keys, operation mix, time-of-day patterns over the local file) and
  explain the result conversationally. No confirmation step.
- **Logs still in a bucket** — this is cloud-side data movement, so it stays a
  confirmed step: propose `plan_access_log_import` to bring them in under a
  reviewed plan; once the user confirms, read the resulting findings.

Either way, route permission decisions to `storageops-security-iam-policy` and
cost decisions to `storageops-lifecycle-cost`.

You can use `list_objects` to help locate where logs are being delivered (e.g. a
`logs/` prefix) before proposing the import.

## Ask the user (only what tools can't reveal)

- Provider and where logs are delivered; a sample log line (first ~200 chars) so
  the format is unambiguous.
- The time window of interest and the baseline to compare a spike against.

## What to report

The traffic/error/cost pattern grounded in the analysis run (top requesters,
status-code mix, hot keys, anomalies), clearly separating what the logs show from
inference, and a hand-off to the security or cost skill for the decision.
