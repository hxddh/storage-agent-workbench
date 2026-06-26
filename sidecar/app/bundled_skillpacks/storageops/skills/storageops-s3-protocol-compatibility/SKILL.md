---
name: storageops-s3-protocol-compatibility
description: >
  Diagnose S3 protocol-level failures: SignatureDoesNotMatch, InvalidArgument,
  MalformedXML, NotImplemented, MissingContentLength, BadDigest. Covers
  signature version mismatches (v2/v4), header ordering, chunked encoding,
  query string auth, and provider-specific S3 API differences. Use when errors
  suggest protocol-level issues rather than application errors.
maturity: core
mode: light_heavy
estimated_tokens: 1400
trigger_keywords:
  - SignatureDoesNotMatch
  - InvalidArgument
  - MalformedXML
  - NotImplemented
  - MissingContentLength
  - BadDigest
  - signature version
  - SigV2
  - SigV4
  - chunked encoding
  - query string auth
  - presigned URL
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
  - capture_http_trace
---

# S3 Protocol Compatibility Diagnosis

Diagnose failures at the S3 wire protocol level. Most issues reduce to: signature mismatch, header encoding, XML body format, or missing API implementation.

> **Scope boundary:** this skill owns the wire protocol — signature (SigV4/SigV2), canonical request and StringToSign, required headers, chunked encoding, XML body schema, CORS, and provider protocol quirks. `storageops-network-endpoint-access` owns DNS/TCP/TLS reachability (connection refused, cert errors, name resolution). `storageops-security-iam-policy` owns identity and permission failures (403/AccessDenied) — a *valid* signature that is *denied* is an IAM problem, not a protocol one.

## Decision Tree

```
Protocol error →
  ├─ SignatureDoesNotMatch? → Signature path
  │   ├─ SigV2 tool → SigV4-only endpoint? → Switch to SigV4 or enable SigV2 on endpoint
  │   ├─ SigV4 + StringToSign mismatch? → Clock skew, wrong region, or header reordering by proxy
  │   └─ Presigned URL expired? → Check Expires parameter, check clock
  ├─ MalformedXML? → XML body path
  │   ├─ Request body has wrong XML? → Check API doc for correct schema
  │   └─ Response body unparseable? → Provider returned non-standard XML
  ├─ NotImplemented? → Missing API
  │   ├─ S3 API not supported by provider? → Find alternative API or SDK
  │   └─ Feature gated (requires opt-in)? → Check provider docs
  ├─ InvalidArgument? → Parameter error
  │   ├─ Header value? → Check value format, encoding, valid range
  │   └─ Query parameter? → Check parameter name and value encoding
  ├─ BadDigest / x-amz-content-sha256 mismatch? → Payload-hash path (not corruption)
  │   └─ Body encoded (gzip) but hash over raw bytes? → hash the sent bytes; see references/checksum-etag.md
  └─ 400 Bad Request (no code)? → Debug-level header inspection needed
```

## Workflow

### Step 1: Extract Signature Information
From debug output: signature version (v2/v4), `StringToSign`, `CanonicalRequest`, and `Authorization` header format. See `references/sigv4.md`. For saved XML/debug artifacts, run `python3 scripts/parse_sigv4_error.py <error-xml-or-debug-log> --json` to extract canonical request fields and credential scope. For a `BadDigest`/`x-amz-content-sha256` mismatch on a PUT/copy, run `python3 scripts/check_payload_hash.py --raw-file <object> --declared-sha256 <value> [--content-encoding gzip]` to confirm deterministically whether the payload hash was computed over the wrong (pre-encoding) bytes.

If the user can run a minimal read-only command and header/status evidence would
change the diagnosis, use `capture_http_trace` with a required `filter_host`.
Only wrap read-only commands such as `aws s3api head-object` or `aws s3 ls`.
Do not request body capture, HAR/record output, replay, or mutating operations.

For **write-side** failures (PUT/copy/upload, including `BadDigest` and
`SignatureDoesNotMatch`), do not trace the write — re-sending a write performs a
real mutation. Get the request from the server error body and the client's own
debug dump, then recompute offline. See `references/checksum-etag.md`
(*Write-side request evidence*). Read-only trace use is unchanged.

### Step 2: Compare Against AWS S3 Baseline
AWS S3 is the reference implementation. Check `references/aws-s3-baseline.md` for expected behavior of the failing operation.

### Step 3: Identify Provider-Specific Quirks
See `references/provider-quirks/bos.md` for known differences per provider (BOS header naming, OSS signature region requirement, COS chunked encoding behavior).

### Step 4: Root Cause Classification
- **Tool-side**: wrong signature version, clock skew, header reordering by proxy/lib
- **Provider-side**: missing API, non-standard error format, stricter validation
- **Protocol mismatch**: chunked transfer encoding, Content-MD5 vs x-amz-content-sha256, virtual-hosted vs path-style

### Step 5: Scope
Is this a single-operation issue or a systemic compatibility problem? Test with a simple operation (ListBuckets) to isolate.

### Step 6: Feedback Loop
If the root cause is unclear after scope analysis, ask the user: **"Can you provide the debug output with signature headers (`--debug` flag in aws CLI, `-vv --dump headers` in rclone)?"** For `SignatureDoesNotMatch`, compare the `StringToSign` and `CanonicalRequest` from debug output against the expected format in `references/sigv4.md`. If confidence < medium, go back to Step 2 and request a complete debug trace with the full authorization header (redact credentials).

## User Interaction

### When to ask the user:
- **"Can you share the debug output with full request/response headers?"** — protocol issues live in the headers
- **"What tool and version are you using? Does it use SigV2 or SigV4?"** — signature version mismatch is the #1 protocol issue
- **"What endpoint URL are you using (virtual-hosted style or path-style)?"** — DNS and URL format affect signing

### When to inform the user:
- Before suggesting a provider-side fix: **"This is the expected behavior of this provider's S3 implementation. Here's how to work around it."**
- After diagnosis: **"If the issue is a provider bug, please open a support ticket with the provider and reference the debug trace."**

## Output Contract — include these fields

```markdown
## Summary
[one-line diagnosis]
**Route**: storageops-s3-protocol-compatibility
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[signature-mismatch|clock-skew|header-reordering|missing-api|xml-format|chunked-encoding|payload-hash|provider-quirk], affected_layer=[client-sdk|proxy|request-encoding|provider-protocol]

## Key Evidence
- Error: [code + message]; signature version: [v2/v4, if known]
- Provider: [AWS/BOS/OSS/COS/GCS]; endpoint URL: [sanitized]
- Protocol analysis: [StringToSign or CanonicalRequest analysis if available]

## Remediation
1. **[fix]** (manual-only) — [config change or SDK upgrade]
2. **[workaround]** — [alternative API or SDK]
```

## What Would Falsify This
- The recomputed CanonicalRequest/StringToSign matches the client's debug dump byte-for-byte yet the request still fails — points away from header reordering toward a credential, region-scope, or clock-skew cause.
- `ListBuckets` (a minimal signed call) succeeds against the same endpoint and credentials — isolates the failure to one operation/parameter rather than a systemic SigV2-vs-V4 mismatch.
- The same request succeeds against AWS S3 but fails against the provider — confirms a provider-specific quirk rather than a client-side signing bug.

## Risks / Open Questions
- Signature debug traces carry the `Authorization` header and credential scope; ensure secrets are redacted before sharing, and never re-send a write request to "trace" it (that performs a real mutation).
- Provider quirks evolve: BOS/OSS/COS support for SigV2, virtual-hosted style, and aws-chunked encoding changes across endpoint versions — confirm against current provider docs rather than assuming a fixed quirk.
- Clock skew (>15 min) and proxy/load-balancer header rewriting are environmental and may not be visible in the client debug output alone; host time and intermediary config may need separate confirmation.

## Examples

### Example 1: SigV2 tool → SigV4-only BOS endpoint
**Input**: s3cmd (SigV2 default) against BOS endpoint. Error: `SignatureDoesNotMatch`.
**Diagnosis**: BOS requires SigV4 by default; s3cmd defaults to SigV2.  
**Fix**: `--signature-v2` flag on s3cmd (if BOS supports it), or switch to aws CLI/SDK which use SigV4.

### Example 2: Chunked encoding rejected
**Input**: SDK upload with `x-amz-content-sha256: STREAMING-AWS4-HMAC-SHA256-PAYLOAD`. Error: `InvalidArgument: Chunked transfer encoding not supported`.
**Diagnosis**: Provider doesn't support AWS chunked upload (aws-chunked).  
**Fix**: Set `Content-Length` header explicitly (single-shot upload), or use SDK flag to disable chunked encoding. Check `references/provider-quirks/bos.md`.

### Example 3: Virtual-hosted style DNS failure
**Input**: `https://bucket.s3.bj.bcebos.com/obj` → `NameResolutionError`.
**Diagnosis**: BOS doesn't support virtual-hosted style for custom endpoints. Must use path-style.  
**Fix**: Use `https://s3.bj.bcebos.com/bucket/obj` (path-style).

## References
- `references/sigv4.md` — SigV2 vs SigV4 deep dive, StringToSign format | **Read when:** user reports SignatureDoesNotMatch or signature-related errors
- `scripts/parse_sigv4_error.py` — Offline parser for SignatureDoesNotMatch XML/debug traces; run `python3 scripts/parse_sigv4_error.py <error-xml-or-debug-log> --json` | **Run when:** user provides saved SigV4 error XML or client debug logs
- `scripts/check_payload_hash.py` — Optional offline falsifier for BadDigest/x-amz-content-sha256 mismatch; run `python3 scripts/check_payload_hash.py --raw-file <object> --declared-sha256 <value> [--content-encoding gzip]` | **Run when:** a PUT/copy returns BadDigest and you can sample the uploaded bytes
- `references/aws-s3-baseline.md` — AWS S3 baseline behavior by operation | **Read when:** comparing provider behavior against AWS S3 reference
- `references/provider-quirks/bos.md` — Baidu BOS protocol quirks (header naming, leading-dash multipart ETag) | **Read when:** the provider is BOS, named or detected
- `references/provider-quirks/oss.md` — Alibaba OSS protocol quirks (signature region, multipart ETag) | **Read when:** the provider is OSS, named or detected
- `references/provider-quirks/cos.md` — Tencent COS protocol quirks (chunked encoding, multipart ETag) | **Read when:** the provider is COS, named or detected
- `references/provider-quirks/minio.md` — MinIO protocol quirks (AWS-compatible multipart ETag) | **Read when:** the provider is MinIO, named or detected
- `references/checksum-etag.md` — Checksum/ETag semantics, BadDigest payload-hash class, and write-side request evidence | **Read when:** user reports checksum/MD5 mismatch, ETag surprises, BadDigest, or a failing PUT/copy
- `references/multipart-upload.md` — aws-chunked, content-length, transfer-encoding | **Read when:** user reports InvalidArgument or chunked encoding errors
- `references/cors.md` — S3 CORS behavior and browser preflight failures | **Read when:** user reports browser CORS, preflight, or missing Access-Control headers
- `references/list-objects.md` — Request/response XML schemas, provider differences, and Unicode/encoding in keys and headers | **Read when:** user reports MalformedXML, XML parsing errors, or encoding issues with special characters in object keys
