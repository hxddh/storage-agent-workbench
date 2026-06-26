---
name: storageops-event-notification
description: >
  Diagnose S3 event notification failures: Lambda not triggered, SQS queue
  not receiving events, SNS topic not publishing, EventBridge events missing.
  Covers notification configuration, IAM permissions chaining, event type
  filtering, prefix/suffix filters, Lambda concurrency, and event delivery
  latency. Use when user expects events from S3 but targets aren't receiving them.
maturity: mature
mode: light_heavy
estimated_tokens: 1300
trigger_keywords:
  - event notification
  - Lambda not triggered
  - SQS not receiving
  - SNS notification
  - EventBridge
  - s3:ObjectCreated
  - s3:ObjectRemoved
  - notification configuration
  - event missing
  - CloudTrail
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
---

# S3 Event Notification Diagnosis

S3 events follow a chain: Object action → Notification rule match (event type + prefix/suffix filter) → IAM permissions → Target (Lambda/SQS/SNS/EventBridge). A break at any link stops delivery.

> **Scope boundary:** this skill owns event *delivery* failures — notification rules, event-type/filter matching, and the target's own resource policy (Lambda/SQS/SNS allow for `s3.amazonaws.com`). Identity-side and bucket-policy permission errors (a caller's `AccessDenied`, principal/role/condition problems on the *bucket* policy) belong to `storageops-security-iam-policy`. Tool/SDK-version-specific behavior (an SDK default that suppresses events) routes to `storageops-cli-sdk-diagnosis`.

## Decision Tree

```
Event not delivered →
  ├─ No events at all? → Configuration chain (Step 1-3)
  │   ├─ Notification config exists? → Check bucket notification settings
  │   ├─ Event type matches? → ObjectCreated:Put vs ObjectCreated:CompleteMultipartUpload
  │   └─ Prefix/suffix filter correct? → Most common: wrong prefix or missing suffix
  ├─ Some events missing (intermittent)? → Delivery chain (Step 4-6)
  │   ├─ Lambda concurrency limit? → Throttled invocations (Step 5)
  │   ├─ SQS message size limit? → Event >256KB gets dropped
  │   └─ Target has resource policy allowing S3? → Often overlooked (Step 4)
  └─ Events arriving but wrong format? → EventBridge vs direct notification
```

## Workflow

### Step 1: Verify Notification Configuration Exists
Check `PUT Bucket notification` configuration on the source bucket. No config = no events. Simple but commonly overlooked after bucket recreation.

When you have the notification JSON (e.g. `aws s3api get-bucket-notification-configuration` output), run
`python3 scripts/notification_config_analyzer.py --config notif.json --key <object key> --event s3:ObjectCreated:CompleteMultipartUpload --json`
to determine deterministically whether a rule matches — it covers Steps 1–3
(no-config / event-type-mismatch / prefix-suffix-filter-mismatch) — then reason
over its verdict.

### Step 2: Check Event Type Matching
- `s3:ObjectCreated:Put` — fires on PUT (single-shot upload)
- `s3:ObjectCreated:CompleteMultipartUpload` — fires on multipart completion
- `s3:ObjectCreated:*` — fires on ANY object creation
- `s3:ObjectRemoved:*` — fires on delete/multi-delete
**Common mistake**: Expecting `ObjectCreated:*` to fire on multipart completion when only `ObjectCreated:Put` is configured.

### Step 3: Check Prefix/Suffix Filters
Notification rules support prefix and suffix filtering. If configured, events only fire for matching objects. Empty/missing filter = match all.

### Step 4: Target Resource Policy (events configured but not delivered / target not firing)
When Step 1 shows a rule *would* fire but the target never receives events, the #1 cause is the target's own resource policy not allowing S3 — and S3 returns NO error. S3 needs `lambda:InvokeFunction` to call Lambda, or `sqs:SendMessage` to send to SQS. But ALSO:
- **Lambda**: Resource-based policy must allow `s3.amazonaws.com` as principal + `lambda:InvokeFunction` + source bucket ARN
- **SQS**: Queue policy must allow S3 principal `s3.amazonaws.com` + `sqs:SendMessage`
- **SNS**: Topic policy must allow S3 principal + `sns:Publish`

Check this deterministically with the target's resource policy (Lambda `get-policy`, or the SQS/SNS `Policy` attribute):
`python3 scripts/notification_target_policy_validator.py --file <target-policy.json> --target-type lambda --source-bucket-arn arn:aws:s3:::<source-bucket>`
It reports `policy_ok`, the exact `missing` statement(s), and a `suggested_statement` — then reason over its verdict.

### Step 5: Lambda Concurrency
If Lambda is throttled (`TooManyRequestsException`), events are retried but may ultimately be dropped if backlog exceeds retention. Check Lambda reserved concurrency and CloudWatch throttle metrics.

### Step 6: Delivery Reliability
S3 event notifications are at-least-once delivery, but NOT guaranteed. For critical workflows, enable S3 event notification to SQS as a durable buffer, then have Lambda consume from SQS.

### Step 7: Feedback Loop
If the notification chain appears correct but events are still missing, ask the user: **"Can you check CloudWatch metrics for Lambda throttles or SQS `NumberOfMessagesSent` vs `NumberOfMessagesReceived`?"** — this isolates whether S3 is emitting events but the target is dropping them. If Lambda is the target: **"Check the Lambda CloudWatch Logs for `TIMEOUT` or `Throttled` events."** If confidence < medium, go back to Step 1 and request the full notification configuration XML/JSON.

## User Interaction

### When to ask the user:
- **"What bucket event types are configured? Share the notification configuration."** — event type mismatch is the #1 issue
- **"Is the target a Lambda, SQS, or SNS? Has it worked before, or is this a new setup?"**
- **"Can you check CloudWatch metrics for Lambda throttles or SQS queue depth?"** — delivery failures show up in target metrics

### When to inform the user:
- **"S3 silently drops events if the target lacks proper permissions — there is NO error returned to the caller."** — this surprises most users
- **"S3 event notifications are at-least-once delivery, NOT exactly-once. Your target must be idempotent."**

## Output Contract — include these fields

```markdown
## Summary
[one-line diagnosis]
**Route**: storageops-event-notification
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[no-config|event-type-mismatch|filter-mismatch|iam-gap|lambda-throttle|target-policy], affected_layer=[rule|target_policy|filter|event_type]

## Key Evidence
- Bucket notification config: [present? event types? filters?]
- Target type: [Lambda/SQS/SNS/EventBridge]; error logs: [CloudWatch/SQS DLQ]
- Chain trace: notification config [OK/missing] → target resource policy [OK/missing — principal:s3.amazonaws.com] → Lambda concurrency [OK/throttled]

## Remediation
1. **[fix]** (manual-only)

## What Would Falsify This
- [config, target-policy, or delivery evidence that would overturn the diagnosis]

## Risks / Open Questions
- [non-AWS event model differences, missing target policy/logs, EventBridge mode]
```

## Examples

### Example 1: Lambda not triggered on multipart upload
**Input**: Lambda processes new objects. Works for small files, but larger files (>5MB multipart) don't trigger.
**Diagnosis**: Event type is `s3:ObjectCreated:Put` only. Multipart uploads emit `s3:ObjectCreated:CompleteMultipartUpload`, not `Put`.
**Recommendation**: Add `s3:ObjectCreated:CompleteMultipartUpload` to notification event types. Or use `s3:ObjectCreated:*`.

### Example 2: SQS not receiving — missing queue policy
**Input**: S3 notification configured to send to SQS, but queue remains empty.
**Diagnosis**: SQS queue policy missing — S3 principal not authorized. S3 silently drops events if target doesn't have proper permissions (no error returned to caller).
**Recommendation**: Add SQS queue policy: Principal `s3.amazonaws.com`, Action `sqs:SendMessage`, Condition `ArnLike: {aws:SourceArn: arn:aws:s3:::source-bucket}`.

### Example 3: Intermittent event loss under load
**Input**: Events delivered normally until high traffic. Under load, some events never arrive.
**Diagnosis**: Lambda concurrency limit reached. S3 retries events, but if Lambda stays throttled, events eventually expire.
**Recommendation**: Increase Lambda reserved concurrency. Or fan-out: S3→SNS→SQS (subscription filter)→Lambda. SQS acts as durable buffer.

## What Would Falsify This
- The target resource policy already allows `s3.amazonaws.com` to `InvokeFunction`/`SendMessage`/`Publish` (validator reports `policy_ok: true`), yet events are still missing → the gap is upstream: re-check the rule's event type and prefix/suffix filter, not the target policy.
- CloudTrail (or the target's own metrics) shows the event WAS emitted and delivered → delivery is fine; the problem is in the consumer (Lambda code error, SQS not polled), not the notification chain.
- Events arrive intermittently rather than never → points to throttling/concurrency or message-size limits (Steps 5–6), not a missing/wrong policy or filter.

## Risks / Open Questions
- **Cross-account targets**: when the bucket and target are in different accounts, the allow may also need `aws:SourceAccount` alongside `aws:SourceArn`; confirm the account id, not just the bucket ARN.
- **Fan-out (S3→SNS→SQS)**: a correct SNS topic policy is necessary but not sufficient — the SQS subscription and the queue's own policy allowing the SNS topic must also be present.
- **Lambda concurrency / DLQ**: a valid policy can still lose events under sustained throttling or a misconfigured/absent DLQ; the validator confirms permission, not delivery durability.
- **Non-AWS providers** (BOS/OSS/COS): event-trigger permission models differ; `--target-type` heuristics assume AWS action names — confirm provider semantics via `references/provider-compatibility.md`.

## References
- `scripts/notification_config_analyzer.py` — Offline notification-config matcher (event type + prefix/suffix filter vs an object key); **AWS model** (emits `"model":"aws"`) | **Run when:** events are not delivered and you have the notification configuration JSON
- `scripts/notification_target_policy_validator.py` — Offline target resource-policy validator (Lambda/SQS/SNS allow for `s3.amazonaws.com`); **AWS model** — for BOS/OSS/COS targets see `references/notification-configuration.md` | **Run when:** the rule would fire but events still are not delivered, and you have the target's resource policy JSON
- `references/notification-configuration.md` — Full notification schema, event types | **Read when:** user provides notification config XML/JSON or asks about event type matching
- `references/lambda-integration.md` — Lambda resource policy, concurrency, DLQ | **Read when:** target is Lambda, or user reports Lambda not being invoked
- `references/sqs-integration.md` — SQS queue policy, message attributes | **Read when:** target is SQS, queue is empty despite notifications configured
- `references/sns-integration.md` — SNS topic policy, subscription filters | **Read when:** target is SNS, or fan-out pattern is needed
- `references/provider-compatibility.md` — Non-AWS event notification (BOS/OSS/COS event triggers) | **Read when:** the provider is non-AWS — named or reported by `detect_domain` — and event notification is involved
