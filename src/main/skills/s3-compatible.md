---

name: s3-compatible
description: Working with MinIO, Ceph RGW, Cloudflare R2, Wasabi, Backblaze B2, Alibaba OSS and other S3-compatible endpoints.
---

An account with a custom endpoint answers every service at that endpoint. Most of AWS beyond S3 does not exist there.
- **What usually works**: `ListBuckets`, `ListObjectsV2`, `HeadObject`, `GetObject`, `GetBucketPolicy`, `GetBucketVersioning`, `GetBucketLifecycleConfiguration`, often `GetBucketEncryption`, `GetBucketCors`, `GetObjectLockConfiguration`.
- **Often missing or partial**: ACLs (R2 has none), `GetBucketPolicyStatus`, `GetPublicAccessBlock`, `GetBucketOwnershipControls`, S3 Control, inventory, Storage Lens. IAM/STS/CloudTrail/CloudWatch calls will fail or return the gateway's own error.
- A `NotImplemented`, `MethodNotAllowed` or `XNotImplemented` error means the feature does not exist there — that is an answer about the platform, not about the bucket. Say what you could not check.
- **Public access** must then be decided from the bucket policy (MinIO: `GetBucketPolicy`; anonymous policies use `Principal: {"AWS": ["*"]}`) and, above all, from `probe`: an unsigned `GET` on `<endpoint>/<bucket>/` and on a known key.
- Path-style addressing is common (`<endpoint>/<bucket>/<key>`); virtual-hosted style may not resolve.
- Regions are often fictional (`us-east-1`, `auto` on R2); use what the account says.
