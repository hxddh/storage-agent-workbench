---

name: encryption
description: How data is encrypted at rest and in transit, which keys protect it and who controls them.
---

## At rest

- `s3 GetBucketEncryption {Bucket}`: default encryption — `AES256` (SSE-S3), `aws:kms` (SSE-KMS), `aws:kms:dsse`. Since 2023 every new object is encrypted at least with SSE-S3; "unencrypted" now usually means "older objects".
- `BucketKeyEnabled` reduces KMS calls and cost.
- Objects can differ from the default: `HeadObject {Bucket, Key}` shows `ServerSideEncryption` and `SSEKMSKeyId` per object. For a whole bucket, an S3 Inventory report (`query` → `inventory({bucket})`) has an `EncryptionStatus` column when configured; otherwise sample with `HeadObject`.
- A policy can require encryption: `Deny` on `s3:PutObject` when `s3:x-amz-server-side-encryption` is missing or not `aws:kms`.

## The key

For SSE-KMS: `kms DescribeKey {KeyId}` (customer- or AWS-managed, enabled, multi-region), `GetKeyRotationStatus`, `GetKeyPolicy {PolicyName: "default"}`, `ListGrants`. An AWS-managed key (`aws/s3`) cannot be shared across accounts or have its policy changed. A disabled or pending-deletion key makes every object under it unreadable — say that loudly.

## In transit

A policy statement denying requests where `aws:SecureTransport` is `false` enforces TLS. Without it, plain HTTP requests are accepted. `s3:TlsVersion` conditions pin a minimum version.

## S3-compatible endpoints

MinIO, Ceph and others support SSE-S3/SSE-KMS/SSE-C differently or not at all; read `GetBucketEncryption` and report the error code if the operation is not implemented.
