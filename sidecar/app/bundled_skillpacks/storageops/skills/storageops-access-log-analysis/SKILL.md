---
name: storageops-access-log-analysis
description: >
  Parse and analyze object storage server access logs (AWS S3, BOS, OSS, COS).
  Diagnose error spikes, identify top requesters/traffic patterns, detect
  anomalies, and attribute costs. Covers S3 Server Access Logs, BOS logging,
  OSS real-time logs, and COS log delivery. Use when user asks about access
  patterns, error rates, 403/404/503 spikes, cost attribution, or "who is
  accessing my bucket."
maturity: stable
mode: light_heavy
estimated_tokens: 1400
trigger_keywords:
  - access log
  - server access log
  - access pattern
  - who is accessing
  - error rate
  - 403 spike
  - 503 spike
  - request analysis
  - traffic analysis
  - cost attribution
  - bucket access
  - download spike
  - put/get ratio
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
---

# Access Log Analysis

Analyze object storage server access logs to identify error patterns, traffic profiles, anomaly spikes, and cost attribution. All major cloud providers deliver access logs in structured formats (CSV, JSON, or space-delimited).

> **Scope boundary:** this skill owns log parsing and traffic/anomaly analysis. `storageops-security-iam-policy` owns 403/401 permission root-cause (policy/ACL evaluation); `storageops-lifecycle-cost` owns request- and storage-cost attribution. Surface the access-pattern evidence here, then route permission or cost decisions to those skills.

## Decision Tree

```
Access log question →
  ├─ "Why am I getting 403/404/503 errors?"
  │   ├─ Single IP? → API key or permission misconfig (Step 2)
  │   ├─ Multiple IPs? → Bucket policy or public ACL issue (Step 3)
  │   └─ Increasing over time? → Rolled credential or expired token (Step 4)
  ├─ "Who is accessing my bucket?"
  │   ├─ By IP? → Requester IP aggregation (Step 2)
  │   ├─ By requester ID? → IAM principal / canonical user breakdown (Step 3)
  │   └─ By operation? → GET/PUT/LIST/DELETE ratio (Step 4)
  ├─ "Where is my cost coming from?"
  │   ├─ High request count? → Total operations by type (Step 5)
  │   ├─ High data transfer? → Bytes sent per requester (Step 5)
  │   └─ Auth failures? → Pre-signed URL issues or credential rotation (Step 4)
  ├─ "Is there unusual activity?"
  │   ├─ Spike in requests? → Rate anomaly vs baseline (Step 6)
  │   ├─  New IPs/agents? → First-seen requester detection (Step 6)
  │   └─ Off-hours activity? → Time-of-day pattern analysis (Step 6)
  └─ "Performance degradation?" → Latency analysis (Step 7)
```

## Workflow

### Step 1: Identify Log Format
**AWS S3**: `s3://<source-bucket>/logs/` → space-delimited, 20+ fields. Enable via bucket properties → Server access logging.
**BOS**: CSV format, delivered to specified bucket with prefix `bos-logging/`.
**OSS**: Real-time log query via OSS console or Log Service, JSON format.
**COS**: CSV format, delivered to COS bucket, enabled via log management.
Ask: **"What provider and where are your access logs delivered? Share a sample log line (first 200 characters)."**

### Step 2: Error Rate Analysis
Extract HTTP status codes from logs. Group by: 2xx (success), 3xx (redirect), 4xx (client error), 5xx (server error).
- **403 AccessDenied spike**: Check IAM policy changes, credential rotation, bucket policy updates
- **404 NoSuchKey**: Client requesting deleted/moved objects, or listing wrong prefix
- **503 SlowDown**: Throttling — route to performance-diagnosis
- **500 InternalError**: Provider-side issue, contact cloud provider support

### Step 3: Requester Identification
- **Remote IP**: `curl -s https://api.ipify.org?format=json` won't help for logs. Use log field: Remote IP, X-Forwarded-For
- **Requester ID**: IAM principal (AWS), canonical user ID, or STS assumed-role session
- **User-Agent**: SDK version, custom scripts, third-party tools
Suggest: **"If many 4xx errors from a single IP, the client likely has misconfigured credentials."**

### Step 4: Credential & Permission Correlation
Cross-reference error spikes with:
- Recent IAM policy changes (check CloudTrail or equivalent)
- STS temporary credential expiry (1-hour default)
- Pre-signed URL expiry
Ask: **"Have any credentials or bucket policies changed in the past 24 hours?"**

### Step 5: Cost Attribution
- **Request costs**: PUT/COPY/POST/LIST and GET/HEAD have provider-specific rates. PUT-heavy patterns often cost more per request than reads.
- **Data transfer costs**: BytesSent can estimate egress, but only after confirming provider, region, destination, and current pricing.
- **Storage costs**: Not visible in access logs (use billing reports or lifecycle-cost skill)
Suggest: **"If one requester generates 80%+ of bytes sent, consider CloudFront CDN to reduce egress costs."**

### Step 6: Anomaly Detection
- **Volume baseline**: Compare hour-over-hour request counts. >3σ spike = anomaly.
- **New requester**: IPs/IDs not seen in previous 7 days.
- **Unusual operation mix**: Sudden surge in DELETE requests, or PUT without GET (upload storm).
- **Off-hours activity**: Requests between 00:00-06:00 local time when normal traffic is minimal.

### Step 7: Performance Analysis
- **TurnaroundTime**: Server-side processing time (not network latency)
- **TotalTime**: End-to-end time from request receipt to last byte sent
- High turnaround + low error rate → large object or complex LIST operation
- High turnaround + high error rate → server overload or throttling
If latency is the main concern, route to performance-diagnosis.

### Step 8: Feedback Loop
If the log analysis identifies a pattern but the root cause is unclear: **"Can you correlate this time window with recent deployments, configuration changes, or traffic spikes?"** Run the provided log through the parser to extract structured data: `python3 scripts/parse_access_log.py --file <log> --provider <s3|bos|oss|cos|auto> --pretty`, then reason over its JSON instead of eyeballing the raw lines. When 503/SlowDown or 4xx errors cluster, add `--by-prefix <depth>` to localize the hot or error-heavy key prefix (e.g. `--by-prefix 2` groups by the first two `/` levels) — this surfaces the hot-prefix signature that the flat requester/operation view hides. If confidence < medium: **"Can you share a larger log sample (covering a longer time window, e.g., 24-48 hours) to establish a baseline?"**

## User Interaction

### When to ask the user:
- **"Can you share a sample access log line (first 200 characters)? I need to identify the provider and log format."** — format identification is the prerequisite for all analysis
- **"What time period are you investigating? Share the start/end timestamps in UTC."** — needed for anomaly detection and baseline comparison
- **"Have any IAM policies, bucket policies, or credentials changed in the past 24 hours?"** — the most common root cause of 403 spikes
- **"Is this a sudden spike or a gradual increase?"** — sudden = misconfig; gradual = organic growth

### When to inform the user:
- **"S3 Server Access Logs are best-effort delivery — a small percentage of logs may be missing."**
- **"Access logs can be 1-24 hours delayed depending on the provider. For real-time analysis, use CloudTrail (AWS) or equivalent audit logs."**
- **"The log bucket incurs storage costs. Consider lifecycle rules to auto-delete logs older than 90 days."**

## Output Contract — include these fields

```markdown
## Summary
[one-line summary]
**Route**: storageops-access-log-analysis
**Provider**: AWS S3 | BOS | OSS | COS
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[error-spike|access-pattern|anomaly|cost-attribution], affected_layer=[requester|credential|operation-mix|traffic-volume]

## Key Evidence
- Time range: [start — end UTC]
- Total requests: [N]; error rate: [X%] (4xx: [N], 5xx: [N])
- Top requester: [sanitized]; top operation: [GET/PUT/LIST/DELETE] ([N]%)
- What the log reveals about the user's question: [finding]

## Remediation
1. **[category]** (manual-only) — [specific action]
2. **[category]** — [diagnostic or validation command]

## What Would Falsify This
- [evidence that would make the diagnosis unlikely]

## Risks / Open Questions
- [missing data, log delivery gaps, provider-specific caveats]
```

## Examples

### Example 1: 403 AccessDenied spike after credential rotation
**Input**: User reports 403 errors on all API calls starting 14:00 UTC. Logs show `403 AccessDenied` for requester `arn:aws:iam::123456789012:user/data-pipeline`.
**Diagnosis**: IAM access key was rotated at 13:55 UTC but the pipeline config wasn't updated with the new key.
**Recommendation**: Update the pipeline's AWS credentials file with the new access key. Run `aws s3 ls --profile pipeline` to verify. **Urgency: high** — pipeline is down.

### Example 2: Cost investigation — high PUT costs
**Input**: "My S3 bill spiked 3x this month. Can you check if something is wrong?"
**Log Analysis**: 2.3M PUT requests last month vs 200K baseline. All from same IP in us-east-1. User-Agent: `aws-cli/2.15.0`. Timestamps every 5 seconds → scripted upload loop.
**Diagnosis**: A cron job uploading small files every 5 seconds. The request count alone can explain a meaningful cost spike once current provider request pricing is applied. Consolidating into batch uploads would reduce request volume sharply.
**Recommendation**: Modify the cron job to batch uploads every hour. Enable Intelligent-Tiering for uploaded objects. Route to lifecycle-cost for storage class optimization.

### Example 3: Anomaly detection — off-hours DELETE storm
**Input**: User notices objects missing from bucket. No recent changes.
**Log Analysis**: 15,000 DELETE requests between 03:00-03:15 UTC from `arn:aws:iam::123456789012:role/cleanup-lambda`. User-Agent: `boto3/1.34.0`.
**Diagnosis**: A Lambda function with an overly broad lifecycle cleanup rule deleted active objects. The cleanup policy was configured to delete objects older than 1 day instead of 30 days.
**Recommendation**: Immediately suspend the cleanup Lambda. Restore deleted objects from version history (if versioning was enabled) or backup. Fix the cleanup rule to 30 days and add a `dry-run` mode before deployment.

## What Would Falsify This
- The error spike predates any IAM/bucket-policy/credential change in the same window, pointing to client behavior rather than a config root cause.
- Top requester and operation mix are flat versus the 7-day baseline, so a "new requester" or "DELETE storm" anomaly hypothesis does not hold.
- 5xx (503/500) rates correlate with the spike while 4xx stays flat — the issue is provider-side/throttling, not access or permission.

## Risks / Open Questions
- Access logs are best-effort and delayed 1-24h (S3) or buffered (BOS/COS CSV, OSS Log Service), so a short window may undercount and miss the triggering event.
- Logs lack the policy/ACL context to prove a 403 root cause — confirm via CloudTrail (AWS) or the equivalent audit trail before attributing to permissions.
- Field semantics differ across BOS/OSS/COS (turnaround vs total time, requester ID shape); a cross-provider comparison needs `references/provider-log-formats.md` to avoid mismatched columns.

## References
- `references/s3-access-log-format.md` — AWS S3 Server Access Log schema, 20+ fields explained | **Read when:** user provides S3 access logs or asks about S3-specific log fields
- `references/bos-access-log-format.md` — Baidu BOS logging: CSV format, field mapping, delivery configuration | **Read when:** user provides BOS logs or mentions Baidu Cloud
- `references/oss-access-log-format.md` — Alibaba OSS real-time log query, JSON schema, Log Service setup | **Read when:** user provides OSS logs or mentions Alibaba Cloud
- `references/cos-access-log-format.md` — Tencent COS log delivery, CSV fields, bucket-level configuration | **Read when:** user provides COS logs or mentions Tencent Cloud
- `references/error-code-reference.md` — Per-provider error code meanings: 403 variants, 404 distinctions, 503 subtypes | **Read when:** user reports error codes and you need provider-specific semantics
- `references/cost-attribution-guide.md` — Request pricing by operation type across providers, data transfer cost models | **Read when:** user asks about cost, billing, or "why is my bill so high"
- `references/cost-attribution-assumptions.md` — Dated assumptions for turning request and egress counts into cost estimates | **Read when:** user asks for dollar estimates from access logs
- `references/logging-setup.md` — How to enable access logging on S3/BOS/COS/OSS | **Read when:** user doesn't have access logs yet and needs to enable logging
- `references/log-pattern-reference.md` — Status code → root cause → skill routing map | **Read when:** identifying root cause from error patterns in logs
- `references/cloudtrail-event-reference.md` — CloudTrail data event field reference for API-level auditing | **Read when:** user provides CloudTrail logs or needs CloudTrail-specific field definitions
- `references/anomaly-thresholds.md` — Statistical thresholds for hot key, traffic spike, error rate anomaly detection | **Read when:** determining whether a detected pattern is statistically significant
- `references/provider-log-formats.md` — BOS/COS/OSS/S3 log format comparison table and field mapping | **Read when:** user provides logs from non-S3 provider and you need format-specific parsing rules
