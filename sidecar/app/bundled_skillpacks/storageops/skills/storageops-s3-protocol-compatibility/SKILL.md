---
name: storageops-s3-protocol-compatibility
description: >
  Diagnose S3 wire-protocol failures — SignatureDoesNotMatch, SigV2 vs SigV4,
  clock skew, expired presigned URLs, MalformedXML, NotImplemented, CORS, and
  virtual-hosted vs path-style addressing on S3-compatible providers. Use for a
  request that is rejected at the protocol level even though the network is fine
  and the credentials are valid.
domains: [protocol, compatibility]
trigger_keywords:
  - SignatureDoesNotMatch
  - CORS
  - SigV4
  - SigV2
  - AuthorizationHeaderMalformed
  - RequestExpired
  - MalformedXML
---

# S3 Protocol Compatibility Diagnosis

Most issues here reduce to signature mismatch, addressing style, header/clock
problems, or an API the provider doesn't implement. A *valid* signature that is
*denied* is permission (`storageops-security-iam-policy`); a connection that
never completes is transport (`storageops-network-endpoint-access`).

## Decision tree

```
Protocol error →
  ├─ SignatureDoesNotMatch →
  │   ├─ SigV2 client vs SigV4-only endpoint → switch signature version
  │   ├─ Clock skew >~15 min                  → fix client clock (SigV4 tolerance)
  │   ├─ Wrong signing region                  → set the provider's real region
  │   └─ Proxy reorders/strips headers          → bypass/curl direct to compare
  ├─ Presigned URL fails → check Expires + client clock
  ├─ Bucket "not found" on S3-compatible provider → wrong addressing style
  ├─ MalformedXML → request/response XML schema mismatch (non-AWS quirk)
  └─ NotImplemented → API not supported by this provider; use an alternative
```

## Investigate with your read-only tools

- `test_addressing_style` — the highest-signal probe here: it tries
  virtual-hosted and path-style HeadBucket and tells you which works. Many
  SignatureDoesNotMatch / "bucket not found" cases on OSS/BOS/COS are an
  addressing-style mismatch.
- `test_credentials` — if signing fails outright vs. only on one operation, this
  separates a global signature problem from an operation-specific one.
- `inspect_endpoint_tls` — confirm the endpoint host/cert matches the URL being
  signed (SNI/host mismatches surface as signature or connection errors).
- `head_bucket` — confirm a clean signed request succeeds at all.

## Ask the user (only what tools can't reveal)

- Debug output with the full `Authorization` header, `StringToSign`, and
  `CanonicalRequest` (credentials redacted) — `aws --debug`, rclone `-vv --dump headers`.
- Tool + version and whether it uses SigV2 or SigV4.
- The exact endpoint URL and whether they set path-style explicitly.

For write-side failures (PUT/copy), do not re-send the write to reproduce — read
the request from the client's own debug dump and the server error body.

## What to report

The protocol-level root cause (signature version / clock / region / addressing /
unsupported API / XML schema), whether it's client-side or a provider quirk, the
concrete fix (e.g. force path-style, set region, switch SigV4), and a read-only
way to confirm — typically re-running `test_addressing_style` or `head_bucket`.
