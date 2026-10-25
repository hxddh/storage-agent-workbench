# Provider capabilities

The provider kind is selected per account: **Auto** reads the endpoint, or the
user chooses explicitly in Settings. Auto detects R2 (`r2.cloudflarestorage.com`),
Aliyun OSS (`aliyuncs.com`), GCS interop (`storage.googleapis.com`), MinIO
(`minio`, localhost or 127.0.0.1) and otherwise **other**; an empty endpoint is
AWS. A custom AWS-compatible emulator can be marked AWS explicitly.

This matrix describes the S3-compatible surface the app promises. It is not a
silent skip list: for an unknown provider the app still attempts a read, and a
501/405 becomes `provider_unsupported` or a named blind spot. “No” means this
build does not expect that S3 API/concept; it does not mean the underlying cloud
has no access-control or logging feature outside its S3 endpoint.

| Capability | AWS S3 | Cloudflare R2 | MinIO | Aliyun OSS | GCS interop | Other |
|---|---|---|---|---|---|---|
| Bucket policy | yes | yes | yes | yes | unknown | unknown |
| Policy status API | yes | no (local evaluation) | no (local evaluation) | no (local evaluation) | no (local evaluation) | no (local evaluation) |
| ACL | yes | no | unknown | yes | unknown | unknown |
| Public access block | yes | no (policy only) | no | no (policy only) | no | unknown |
| Object ownership | yes | no | no | no | no | unknown |
| Access logging | yes | no | no | yes | no | no |
| Inventory | yes | no | no | no | no | no |
| Account public access block | yes | no | no | no | no | no |
| CloudWatch capacity | yes | no | no | no | no | no |
| CloudTrail | yes | no | no | no | no | no |
| IAM evaluation | yes | no | no | no | no | no |
| KMS key policy | yes | no | no | no | no | no |
| Access Analyzer | yes | no | no | no | no | no |

## How to read it

- **Bucket policy** is read through the S3 API and evaluated locally. Where a
  provider has no policy-status API, the local evaluator is the only exposure
  check.
- **Public access block** and **object ownership** are AWS S3 configuration
  APIs. R2 and Aliyun expose policy-level behavior, not the same four switches.
- **Access logging** and **Inventory** are configuration features; an
  unsupported API is a named capability gap, not a clean result.
- **CloudWatch capacity** is the AWS `AWS/S3` daily metric. Other providers
  publish no equivalent through this app; `query` can measure listed objects
  instead, without pretending it measured the whole bucket.
- **CloudTrail**, **IAM**, **KMS** and **Access Analyzer** are account services,
  not object-storage APIs. Their absence leaves the matching access evidence
  unread.
- **Policy/ACL grants** can still be shown on a non-AWS provider. The access
  view marks the rows as evidence and never turns an unread IAM or SCP source
  into an empty list.

The runtime source is `src/main/s3/capabilities.ts`; `docs/iam.md` lists the AWS
actions the read-only reader can use.
