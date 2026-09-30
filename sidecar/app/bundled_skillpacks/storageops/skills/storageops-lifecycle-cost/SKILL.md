---
name: storageops-lifecycle-cost
description: Storage cost and tiering, lifecycle rules, noncurrent versions, stuck multipart uploads, replication and object lock.
---

# Lifecycle, cost, versions and replication

1. `review_bucket_config(aspects=["lifecycle","cost"])`: missing abort-multipart rule, versions that never expire.
2. Evidence, not guesses: `list_objects(kind="versions")` (noncurrent bytes, delete markers) and
   `list_objects(kind="uploads")` (stuck uploads with upload ids). provider_unsupported = not
   measurable, never "none"; a truncated page is a lower bound.
3. Size and class mix: an inventory (`import_evidence(source_type="inventory")`), then
   `simulate_storage_cost(candidate_rules=[…])` to compare rules. Never quote prices.
4. Account-wide: `query_estate(survey_filter="missing_lifecycle"|"no_versioning")`.
5. Replication: `review_bucket_config(detail="replication")`; versioning must be on at both ends,
   rules are not retroactive, delete markers replicate only when enabled.
   `inspect_object` shows replication_status; `aspects=["lock"]` explains undeletable objects.

Mind minimum storage durations and small-object floors before proposing a transition.
Stop when: the cost driver is named with tool-verified numbers, and each proposed rule is text
the user applies (it affects every matching object).
