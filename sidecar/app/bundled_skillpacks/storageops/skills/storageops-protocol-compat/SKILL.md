---
name: storageops-protocol-compat
description: SignatureDoesNotMatch, region/301, addressing, presigned URLs, TLS/DNS/timeouts, CLI/SDK quirks, stale reads, NotImplemented on S3-compatible providers.
---

# Protocol, network and client

Layers in order: DNS > TCP > TLS > HTTP/signature > API support.

1. `probe_endpoint(check="tls")` for cert/handshake errors; `check="reach"` for whether any request completes.
2. `check="location"`: wrong signing region is the top SignatureDoesNotMatch/301 cause.
3. `check="addressing"`: "bucket not found"/DNS errors on non-AWS endpoints are often path vs virtual-hosted.
4. Presigned URL: `triage_error(url=…)` (expiry, clock skew, scope; no request made).
5. Stale read / ETag: `inspect_object(aspects=["conditional"], etag=…)`; 304 = cache is stale, not the store.
   Same ETag on 200 = provider ignores If-None-Match (a gap). Multipart ETags end in -N.
6. Slow: `probe_endpoint(check="latency")` gives numbers before theories.

NotImplemented/MethodNotAllowed = provider_unsupported: say which API and the alternative.
Clock skew > 15 min breaks SigV4. A proxy can strip headers. Ask for the client, version and
debug output only when the tools cannot tell.
Stop when: the failing layer is named with its probe result, and the fix (path-style, region,
SigV4, CA bundle) is text the user applies.
