---
name: storageops-observability-audit
description: >
  Audit whether a bucket/account is observable — server access logging, event
  notifications, request metrics, inventory reports, and tagging — as one
  coherent method, so gaps that would blind an incident investigation are found
  before they matter. Use for "is my logging set up right?", "why can't I see who
  deleted this?", or a pre-incident readiness check. Interpreting the logs
  themselves belongs to storageops-access-log-analysis.
domains: [observability]
trigger_keywords:
  - access logging
  - server log
  - event notification
  - CloudTrail
  - request metrics
  - inventory report
  - observability
  - who deleted
---

# Observability Audit

Observability is the difference between "we can reconstruct what happened" and
"we're guessing." It has four layers, and a gap in any one blinds a whole class
of later investigation. Audit them together rather than one at a time.

## The four layers

```
1. Access logs      → is server access logging (or CloudTrail data events)
                      enabled, and delivered to a bucket you can actually read?
                      Without it, "who did X, when" is unanswerable after the fact.
2. Event notify     → are events (ObjectCreated/Removed) wired to a queue/topic/
                      function so downstream systems + alerting see changes?
3. Metrics          → are request/latency/error metrics available for trend and
                      anomaly detection (request-cost surprises, 5xx spikes)?
4. Inventory + tags → is a scheduled inventory report configured (the only cheap
                      way to reason about billions of objects), and are objects/
                      buckets tagged enough to attribute cost and ownership?
```

The high-value gap to catch: **logging that's "enabled" but delivered to a bucket
nobody reads, or with a prefix/permission that silently drops delivery** — it
looks configured but yields nothing when you need it.

## Investigate with your read-only tools

- `review_bucket_observability` — the focused read: logging target, notification
  configuration, and tagging in one pass.
- `get_bucket_config_summary` — confirms the logging destination bucket + prefix,
  notification config, and tag set actually present on the bucket.
- `head_bucket` / `list_objects` on the **logging destination** bucket — verify
  logs are truly landing there (config says "on", but are objects arriving?).
- `list_uploaded_files` + `analyze_uploaded_file` — if the user attaches an
  access-log or inventory export, analyze it for coverage; for data still in a
  bucket, propose `plan_inventory_import` / an access-log import (confirmed).
- Run `review_bucket_config` (inline, read-only) for the full posture; for the
  account-wide view use `survey_account`.

## Ask the user (only what tools can't reveal)

- Whether a central logging/audit account or SIEM already ingests these, so you
  don't flag a gap that's covered elsewhere.
- Retention requirements (how far back must "who did what" be answerable).

## What to report

Per layer: enabled / misconfigured / missing, grounded in what you could read vs.
verify (config-says-on vs. logs-actually-arriving), the concrete blind spot each
gap creates ("no access logging → cannot answer who deleted an object"), and the
manual fix. State which findings are config-verified vs. delivery-verified.
