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
  ├─ CORS error (browser preflight blocked) → read the bucket's CORS rules:
  │     missing rule, or origin/method/header not allowed (over-broad `*` is its
  │     own risk → storageops-security-iam-policy)
  ├─ MalformedXML → request/response XML schema mismatch (non-AWS quirk)
  └─ NotImplemented → API not supported by this provider; use an alternative
```

## Investigate with your read-only tools

- `test_addressing_style` — the highest-signal probe here: it tries
  virtual-hosted and path-style HeadBucket and tells you which works. Many
  SignatureDoesNotMatch / "bucket not found" cases on OSS/BOS/COS are an
  addressing-style mismatch.
- `diagnose_presigned_url` — for "my presigned URL 403s / AccessDenied": paste
  the URL and this COMPUTES the answer (expired? clock skew? wrong region scope?
  legacy SigV2? path vs virtual-hosted). Pure parse — no request is made and the
  signature/key-id never leave the tool. Reach for this instead of interviewing
  the user about the URL.
- `test_credentials` — if signing fails outright vs. only on one operation, this
  separates a global signature problem from an operation-specific one.
- `get_bucket_config_summary` — its `bucket_region` + `region_mismatch` fields
  confirm the #1 SignatureDoesNotMatch cause: the bucket's real region differs
  from the provider's configured signing region.
- `inspect_endpoint_tls` — confirm the endpoint host/cert matches the URL being
  signed (SNI/host mismatches surface as signature or connection errors).
- `head_bucket` — confirm a clean signed request succeeds at all.
- `get_bucket_config_detail` (aspect `cors`) — for a CORS failure, the per-rule
  allowed origins / methods / headers, so you can say whether a rule is missing
  or just doesn't cover the request's origin/method. `review_bucket_security`
  cross-checks the posture and flags an over-broad `*` origin.

## Ask the user (only what tools can't reveal)

- Debug output with the full `Authorization` header, `StringToSign`, and
  `CanonicalRequest` (credentials redacted) — `aws --debug`, rclone `-vv --dump headers`.
- Tool + version and whether it uses SigV2 or SigV4.
- The exact endpoint URL and whether they set path-style explicitly.

For write-side failures (PUT/copy), do not re-send the write to reproduce — read
the request from the client's own debug dump and the server error body.

## Provider capability matrix (treat AWS-isms as assumptions elsewhere)

S3-compatible providers (MinIO, Ceph/RGW, R2, B2, Backblaze, Wasabi, OSS, COS,
BOS, GCS-XML…) implement a *subset* of the S3 API with their own quirks. Never
assume an AWS behavior holds until confirmed against the provider:

- **Addressing** — many require path-style; virtual-hosted may not resolve.
  `test_addressing_style` decides it empirically.
- **Unimplemented APIs** — object-lock, replication, inventory, some tagging /
  versioning calls often return `NotImplemented` / `MethodNotAllowed`. Surface
  these as **`Provider unsupported`**, not a hard failure — the read-only tools
  already normalize to that status; carry it through to the user.
- **Signature / region** — some need a specific signing region string or only
  SigV2; a valid-looking SigV4 can still be rejected.
- **Semantics** — ETag isn't always MD5 (multipart, server-side encryption);
  conditional headers, `ListObjectsV2`, and delimiter behavior vary.

When a capability is missing, say which provider, which API, and the practical
alternative — don't present an AWS-only workflow as universal.

## What to report

The protocol-level root cause (signature version / clock / region / addressing /
unsupported API / XML schema), whether it's client-side or a provider quirk, the
concrete fix (e.g. force path-style, set region, switch SigV4), and a read-only
way to confirm — typically re-running `test_addressing_style` or `head_bucket`.
