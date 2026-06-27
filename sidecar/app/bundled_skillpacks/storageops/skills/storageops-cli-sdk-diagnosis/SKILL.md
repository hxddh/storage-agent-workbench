---
name: storageops-cli-sdk-diagnosis
description: >
  Diagnose errors from object storage CLI tools and SDKs (s5cmd, rclone, aws
  CLI, boto3, minio client, s3cmd, bcecmd, obsutil). Covers tool-specific bugs,
  version incompatibilities, configuration mistakes, and cross-tool behavioral
  differences. Use when user reports errors from a specific client tool or SDK.
maturity: mature
mode: light_heavy
estimated_tokens: 1400
trigger_keywords:
  - s5cmd
  - rclone
  - aws CLI
  - boto3
  - minio client
  - s3cmd
  - bcecmd
  - obsutil
  - CLI error
  - SDK error
  - botocore
  - tool version
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
  - capture_http_trace
---

# CLI & SDK Diagnosis

Tool-specific known issues: s5cmd 429 handling, rclone multipart ETag incompatibility with BOS, boto3 clock skew, aws CLI signature version defaults. Cross-reference the tool's reference file for detailed patterns.

> **Scope boundary:** general 429/SlowDown throttling belongs to `storageops-performance-diagnosis`. Stay here only for *tool-version-specific* 429 behavior (e.g. an SDK's default concurrency or retry policy); route service-side rate limiting to performance.

## Decision Tree

```
CLI/SDK error →
  ├─ s5cmd? → Check `references/s5cmd.md`
  │   ├─ 429 SlowDown? → Concurrency too high (default 256 workers)
  │   └─ SignatureDoesNotMatch? → Clock skew or wrong region
  ├─ rclone? → Check `references/rclone.md`
  │   ├─ multipart upload corruption? → ETag format mismatch (BOS vs AWS)
  │   └─ "directory not found"? → rclone VFS cache issue
  ├─ aws CLI? → Check `references/awscli.md`
  │   ├─ SignatureDoesNotMatch? → Clock skew >~15 min (SigV4 tolerance)
  │   └─ SSL/TLS error? → ca-certificates or proxy
  ├─ boto3/botocore? → Check `references/boto3-botocore.md`
  │   ├─ ClientError 403? → Region mismatch or credential chain
  │   └─ EndpointConnectionError? → Endpoint URL format
  ├─ s3cmd/minio-client? → Check respective reference
  ├─ bcecmd (Baidu)? → Check `references/bcecmd.md`
  └─ obsutil (Huawei)? → Check `references/obsutil.md`
```

## Workflow

### Step 1: Identify Tool + Version
Extract tool name, version, and command used. If version is unknown, ask — many bugs are version-specific.

### Step 2: Parse the Error
Extract error code, error message, and any timing data or stack trace. Compare against known issues in the tool's reference file.

If the CLI/SDK error hides the HTTP status, endpoint host, signing scope, or
redirect behavior, use `capture_http_trace` around one minimal read-only command
for that client. Keep `capture_body=false`, provide `filter_host`, and never wrap
copy/sync/upload/delete commands.

For a failing **write** (PUT/copy/upload — e.g. `BadDigest` or
`SignatureDoesNotMatch`), do not trace the write. Get its request from the server
error body and the client's own debug dump (`--debug`/`-vv --dump headers`/
`set_stream_logger`), then recompute offline — see
`storageops-s3-protocol-compatibility/references/checksum-etag.md`
(*Write-side request evidence*).

### Step 3: Check Configuration
Common misconfigurations: wrong endpoint URL, wrong region, wrong signature version (v2 vs v4), proxy settings interfering, clock skew (>~15 min from server time exceeds the SigV4 tolerance and causes signature failure).

### Step 4: Cross-Tool Comparison
If multiple tools are mentioned: does the same operation fail with a different tool? This isolates tool-specific bugs from service-side issues.

### Step 5: Apply Known Fix
Consult the tool's reference file for known workarounds. These are the most reliable fixes.

### Step 6: Feedback Loop
If s5cmd `--log debug` output is available, run `python3 scripts/parse_s5cmd_log.py --file <log>` to extract timing, concurrency utilization, and error distribution. If the fix does not resolve the issue, ask the user: **"Can you try the same operation with a different tool (e.g., `aws s3 cp` instead of `s5cmd`)? This isolates tool-specific bugs from service-side issues."** If confidence < medium after diagnosis, request a more complete error log (full debug/verbose output, not just the summary error line).

## User Interaction

### When to ask the user:
- **"What tool and version are you using?"** — many bugs are version-specific (e.g., s5cmd v2.0.0 vs v2.2.0)
- **"Can you share the full error output with `--debug`/`-vv` flag?"** — summary errors hide root cause details
- **"Does the same operation succeed with a different client tool?"** — isolates tool-specific bugs

### When to inform the user:
- Before any fix: **"This is non-destructive. The suggested workaround only changes client-side behavior."**
- After diagnosis: **"After applying the fix, validate with a small test first (e.g., 1 small file) before running at full scale."**
- If a tool upgrade is recommended: **"Check the tool's changelog for breaking changes before upgrading."**

## Output Contract — include these fields

```markdown
## Summary
[tool] — [one-line diagnosis]
**Route**: storageops-cli-sdk-diagnosis
**Tool**: [name] [version]
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[tool-bug|tool-version-incompatibility|misconfiguration|clock-skew|provider-incompatibility], affected_layer=[tool|provider|configuration|environment]

## Key Evidence
- Error: [code + message]; command: [sanitized]; tool version: [known/unknown]
- Known issue match: [link to known issue in tool reference, or why it matches]
- Cross-tool check: [does aws CLI succeed where rclone fails?]

## Remediation
1. **[specific config/flag change]** — [rationale]
2. **[workaround]** — [if applicable]
- Validation: [small, safe command or dry-run that proves the fix]

## What Would Falsify This
- [tool/version/provider evidence that would make the diagnosis wrong]

## Risks / Open Questions
- [upgrade risk, provider compatibility, missing version/config data]
```

## Examples

### Example 1: rclone multipart corruption on BOS
**Input**: rclone copy to BOS, files >5GB corrupted. No error, but checksums don't match.
**Diagnosis**: rclone multipart ETag format incompatibility — BOS uses different ETag format for multipart uploads (no `-N` suffix). rclone's integrity check fails.
**Fix**: `--s3-use-multipart-etag=false` on rclone command. Or `--ignore-checksum` as temporary workaround.

### Example 2: s5cmd 429 SlowDown
**Input**: s5cmd sync with default settings, 256 workers, getting `SlowDown (429)`.
**Diagnosis**: Default concurrency (256) exceeds BOS rate limit for prefix.  
**Fix**: `--concurrency 16 --retry-count 10`. Reduce further if 429 persists. BOS per-prefix limit is lower than AWS S3.

### Example 3: aws CLI clock skew
**Input**: `aws s3 ls` returns `SignatureDoesNotMatch: Signature expired`.
**Diagnosis**: Local clock >15 min off from server time. AWS SigV4 signs with timestamp.
**Fix**: `ntpdate -u ntp.aliyun.com` or `sudo ntpdate ntp.aliyun.com`. Verify with `date -u`.

## References
- `references/s5cmd.md` — s5cmd-specific known issues, concurrency defaults | **Read when:** user reports s5cmd errors, 429/SlowDown, or s5cmd sync/cp issues
- `references/rclone.md` — rclone S3 backend quirks, ETag, VFS | **Read when:** user reports rclone errors, multipart corruption, checksum mismatch, "directory not found"
- `references/awscli.md` — AWS CLI configuration, clock skew, proxy | **Read when:** user reports aws CLI errors, SignatureDoesNotMatch, SSL/TLS errors
- `references/boto3-botocore.md` — Python SDK credential chain, retries | **Read when:** user reports boto3/botocore errors, ClientError 403, EndpointConnectionError
- `references/s3cmd.md` — s3cmd signing and compatibility | **Read when:** user mentions s3cmd commands or signature errors with s3cmd
- `references/minio-client.md` — mc (minio client) quirks | **Read when:** user mentions minio client / mc commands
- `references/bcecmd.md` — Baidu BOS CLI specifics | **Read when:** user mentions bcecmd or Baidu BOS CLI
- `references/obsutil.md` — Huawei OBS CLI specifics | **Read when:** user mentions obsutil or Huawei OBS CLI
