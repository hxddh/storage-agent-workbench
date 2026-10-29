# Provider capabilities

The provider kind is selected per account: **Auto** reads the endpoint, or the
user chooses explicitly in Settings. Auto detects R2 (`r2.cloudflarestorage.com`),
Aliyun OSS (`aliyuncs.com`), GCS interop (`storage.googleapis.com`), MinIO
(`minio`, localhost or 127.0.0.1) and otherwise **other**; an empty endpoint is
AWS. A custom AWS-compatible emulator can be marked AWS explicitly.

This matrix describes the S3-compatible surface each provider is expected to
answer. It is not a skip list: `call` sends every read it is asked for to every
provider, and an API the provider does not implement comes back as the
provider's own error (`NotImplemented`, 501, 405), with its code, HTTP status
and message. “No” means this build does not expect that S3 API; it does not
mean the underlying cloud has no such feature outside its S3 endpoint.

| Capability | AWS S3 | Cloudflare R2 | MinIO | Aliyun OSS | GCS interop | Other |
|---|---|---|---|---|---|---|
| Bucket policy | yes | yes | yes | yes | unknown | unknown |
| Policy status API | yes | no | no | no | no | no |
| ACL | yes | no | unknown | yes | unknown | unknown |
| Public access block | yes | no | no | no | no | unknown |
| Object ownership | yes | no | no | no | no | unknown |
| Access logging | yes | no | no | yes | no | no |
| Inventory | yes | no | no | no | no | no |
| Other services (S3 Control, STS, IAM, Organizations, KMS, Access Analyzer, CloudWatch, CloudTrail) | yes | no | no | no | no | unknown |

## How to read it

- **Bucket configuration** is whichever S3 `Get*` operations the agent calls,
  returned as the API answers them. Where a provider has no policy-status API,
  the policy document itself is what the agent reads.
- **Public access block** and **object ownership** are AWS S3 configuration
  APIs. R2 and Aliyun expose policy-level behaviour, not the same switches.
- **Access logging** and **Inventory** are configuration features; an
  unsupported API is an error in the result, not an empty configuration.
- **Other services.** Nothing is skipped by provider kind. On an account with
  no custom endpoint every service goes to AWS (IAM and Organizations to
  `us-east-1`). On a custom-endpoint account, every service goes to that
  endpoint, whatever its kind, and its credentials are never sent to AWS; an
  emulator such as moto or LocalStack answers them, and a storage-only
  endpoint returns its own error. Without CloudWatch, `query` can measure
  listed objects instead, and the agent says it measured a listing, not the
  whole bucket.

This matrix is documentation, not code: the app tries every read and returns
the provider's answer. The runtime sources are `src/main/s3/capabilities.ts`
(kind detection), `s3/api.ts` (the call) and `providers.clientFor` (where each
service is sent); `docs/iam.md` covers AWS permissions.
