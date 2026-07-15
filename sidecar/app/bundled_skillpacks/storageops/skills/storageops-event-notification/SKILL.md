---
name: storageops-event-notification
description: >
  Diagnose object-storage event delivery — notifications not firing or not
  reaching Lambda/SQS/SNS/EventBridge/function-compute targets. Walks the chain:
  object action → notification rule (event type + prefix/suffix filter) → target
  resource policy → target limits. Use for "my Lambda/queue isn't triggered on
  upload". Identity/bucket-policy permission errors go to the security skill.
domains: [notification]
trigger_keywords:
  - notification
  - event
  - SQS
  - SNS
  - Lambda
  - EventBridge
  - trigger
---

# Event Notification Diagnosis

Events flow: object action → a matching notification rule → the target's resource
policy allows the storage service → the target processes it. A break at any link
stops delivery, and storage often returns NO error when the target rejects it.

## Decision tree

```
Event not delivered →
  ├─ none at all →
  │   ├─ notification config exists on the bucket?
  │   ├─ event type matches? (Put vs CompleteMultipartUpload vs ObjectCreated:*)
  │   └─ prefix/suffix filter actually matches the key?
  ├─ intermittent →
  │   ├─ target throttled (Lambda concurrency)?
  │   └─ payload > target limit (SQS 256 KB)?
  ├─ configured but target never fires → target resource policy doesn't allow the storage service (no error surfaced)
  └─ arriving but wrong shape → EventBridge vs direct notification format
```

## Investigate with your read-only tools

- `get_bucket_config_detail` (aspect `notification`) — the per-target rule
  detail: target type (topic/queue/lambda/eventbridge) + resource name, the
  event types, and the prefix/suffix filters. This is the exact evidence "why
  isn't my Lambda firing" needs — read it FIRST, then compare the failing
  object's key against the filter.
- `review_bucket_observability` — the summary pass (does ANY notification rule
  exist, plus logging/tagging posture) when you don't yet know which layer is
  missing.
- `get_bucket_config_summary` — broader readable config to cross-check.
- `head_object` / `list_objects` — confirm the object that *should* have fired an
  event matches the rule's prefix/suffix and event type (e.g. it landed via
  multipart, but only `Put` is configured).

## Ask the user (only what tools can't reveal)

- The notification configuration JSON and the target ARN/type.
- The target's resource policy (does it allow the storage service to invoke/send?).
- A concrete object key + how it was created (single PUT vs multipart).

## What to report

The broken link (no rule / event-type mismatch / filter mismatch / target
resource-policy / target limit), grounded in the notification config you could
read vs. the target policy the user must supply, the fix (add the missing event
type, correct the filter, grant the target's resource policy), and how to verify
(re-check via `review_bucket_observability` and a test object that matches).
