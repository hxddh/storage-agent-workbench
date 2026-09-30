---
name: storageops-account-posture
description: Account-wide overview or audit with no specific error, and observability (logging, notifications, inventory).
---

# Account posture

1. `survey_account` (or `query_estate(survey_filter=…)` when a recent survey exists). Say if it was truncated.
2. `query_estate(since_last_survey=true)` when an earlier survey exists: lead with buckets that became public.
3. Rank: public exposure > missing public access block > no encryption > no lifecycle/versioning > no logging.
4. Go deeper only where the goal needs it: `review_bucket_config(aspects=["security"])` for one bucket;
   `review_bucket_config(detail="logging"|"notification"|"inventory")` for observability.
5. Observability gap to catch: logging "on" but delivered to a bucket nobody reads, or no inventory
   on a large bucket (the only cheap way to size it).

Stop when: every bucket in scope has a verdict or an explicit gap (access_denied,
provider_unsupported are gaps, never "fine"). Do not review every bucket reflexively.
Hand off: exposure → security-iam card; cost → lifecycle-cost card.
