---
name: storageops-access-logs
description: Access logs or inventories — who is accessing, error spikes, throttling (429/503), hot prefixes, capacity and object shape.
---

# Access logs and inventory

1. Attached file: `analyze_uploaded_file(dataset_id)` (the id is on the attachment line).
   In a bucket: `import_evidence(source_type="access_log", time_range_start, time_range_end)` or
   `source_type="inventory"`; the survey must have discovered the source. Say what time range
   and coverage you got; a partial import is a lower bound.
2. Follow-ups on the same dataset, never a re-import:
   - who: `metric="count", group_by="client_ip_masked"` (user agents are not requesters)
   - errors: `metric="count", group_by="status_code"`, or `status_min=400` + `group_by="prefix"`
   - trend: add `group_by_2="day"`; throttling: 503/429 by prefix and hour = hot prefix or burst
   - capacity: `metric="sum_bytes", group_by="prefix"|"storage_class"`
3. Slow with no errors: `probe_endpoint(check="latency")` and
   `review_bucket_config(aspects=["performance"])` (small objects, key layout).

Raw rows never reach you; report aggregates only. Truncated datasets are samples: say so.
Stop when: the pattern is stated with its numbers. Hand off: permissions → security-iam card;
tiering and cost → lifecycle-cost card.
