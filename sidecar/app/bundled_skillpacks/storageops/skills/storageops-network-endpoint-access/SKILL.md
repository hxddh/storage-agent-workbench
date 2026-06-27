---
name: storageops-network-endpoint-access
description: >
  Diagnose transport-layer connectivity to an object-storage endpoint — DNS
  resolution, TCP reachability, TLS/certificate problems, proxies, VPC/private
  endpoints. Use for "connection refused/timeout", "name not resolved", or
  TLS/cert errors — i.e. the request never gets a clean HTTP response. Once
  connected, 400/403/SignatureDoesNotMatch belong to the protocol/security skills.
domains: [network]
trigger_keywords:
  - DNS
  - TLS
  - certificate
  - connection refused
  - connection timeout
  - endpoint
  - VPC
  - host unreachable
---

# Network & Endpoint Access Diagnosis

Isolate the failing layer in order: DNS → TCP → TLS → HTTP. Most object-storage
connectivity issues are DNS/addressing or TLS certificate mismatches.

## Decision tree

```
Connectivity issue →
  ├─ "name not resolved" / DNS error →
  │   ├─ virtual-hosted URL (bucket.endpoint)? → provider may not support it; try path-style
  │   └─ custom/VPC endpoint?                   → private DNS / hosts entry
  ├─ "connection refused" → wrong port (S3 is 443) or firewall/egress rule
  ├─ "connection timeout" → private subnet w/o NAT, cross-region egress, or MTU black hole
  ├─ TLS/SSL error →
  │   ├─ cert name mismatch → SNI / endpoint URL mismatch
  │   ├─ self-signed         → install the correct CA bundle (never disable verification)
  │   └─ expired             → server cert validity
  └─ HTTP 400/403 after connect → not network; route to protocol/security
```

## Investigate with your read-only tools

- `inspect_endpoint_tls` — the key probe: reads the endpoint's TLS version,
  certificate subject/issuer, and validity. Catches expired certs, hostname
  mismatches, and wrong-endpoint cases directly.
- `test_addressing_style` — a "bucket not found"/DNS-looking failure on a
  non-AWS provider is often virtual-hosted-vs-path-style, not true DNS.
- `head_bucket` / `test_credentials` — confirm whether *any* request completes;
  success here means the transport path is fine and the issue is higher up.

## Ask the user (only what tools can't reveal)

- The exact endpoint URL and whether it's public, VPC/private, or on-prem custom.
- A layered timing breakdown from their host, e.g.
  `curl -w 'DNS:%{time_namelookup} TCP:%{time_connect} TLS:%{time_appconnect} total:%{time_total}' -o /dev/null -s https://<endpoint>`.
- Proxy env vars (`HTTP(S)_PROXY`/`NO_PROXY`) — a proxy can strip the
  Authorization header and turn a network issue into a signature error.

## What to report

The failing layer (DNS / TCP / TLS / proxy / private-endpoint), tool-verified
where possible (e.g. TLS facts from `inspect_endpoint_tls`), the fix, and a
read-only way to confirm. If it turns out the transport is healthy, hand off to
the protocol or security skill and say so.
