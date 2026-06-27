---
name: storageops-cli-sdk-diagnosis
description: >
  Diagnose tool- and SDK-specific object-storage failures — awscli, boto3/
  botocore, rclone, s5cmd, s3cmd, mc, bcecmd (Baidu), obsutil (Huawei). Covers
  version-specific bugs, signature-version defaults, clock skew, region/endpoint
  config, and multipart/ETag incompatibilities with S3-compatible providers. Use
  when the failure is tied to a particular client or its configuration.
domains: [cli-sdk]
trigger_keywords:
  - awscli
  - boto3
  - rclone
  - s5cmd
  - bcecmd
  - obsutil
  - SDK error
---

# CLI & SDK Diagnosis

Many failures are client configuration or version-specific behavior, not the
service. Isolate the tool, then compare against a second client. General
service-side 429/SlowDown belongs to `storageops-performance-diagnosis`; this
skill owns tool-version-specific behavior.

## Decision tree

```
CLI/SDK error →
  ├─ SignatureDoesNotMatch  → clock skew, wrong region, or SigV2/SigV4 default → storageops-s3-protocol-compatibility
  ├─ 403 from one tool only  → region/endpoint or credential-chain config (env vs profile vs role)
  ├─ multipart/ETag mismatch on BOS/OSS → provider ETag format differs from AWS; disable client-side multipart ETag check
  ├─ EndpointConnectionError → endpoint URL format / addressing → storageops-network-endpoint-access
  └─ tool-version-specific 429 default → tune the client's concurrency/retry
```

## Investigate with your read-only tools

The client runs on the user's machine, so you confirm the *server side* is sane
and let the user compare their client against it:

- `test_credentials` — proves the configured keys work from the app, isolating a
  bad client credential chain (env vs profile vs instance role).
- `test_addressing_style` — establishes which addressing the provider expects, so
  you can tell the user the correct `--endpoint-url` / path-style flag.
- `head_bucket` / `list_objects` — confirm the same operation the client failed
  on succeeds with valid config, isolating a tool bug from a service problem.

## Ask the user (only what tools can't reveal)

- Tool name + exact version (many bugs are version-specific) and the full command.
- Full debug/verbose output (`aws --debug`, rclone `-vv`, boto3
  `set_stream_logger`) — summary lines hide the cause.
- Whether the same operation succeeds with a different client — the fastest way
  to separate a tool bug from a service issue.

For a failing write, don't re-run it to reproduce; read the request from the
client's own debug dump.

## What to report

The client + version, whether the cause is client-config / a known tool bug / or
actually service-side, the concrete fix (config flag, version change, endpoint/
region correction) marked manual-only, and a small read-only validation (e.g.
one `head-object`) before re-running at scale.
