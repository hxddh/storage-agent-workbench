# Provider capabilities

The provider kind is selected per account: **Auto** reads the endpoint, or the
user chooses explicitly in Settings. Auto detects R2 (`r2.cloudflarestorage.com`),
Aliyun OSS (`aliyuncs.com`), GCS interop (`storage.googleapis.com`), MinIO
(`minio`, localhost or 127.0.0.1) and otherwise **other**; an empty endpoint is
AWS. A custom AWS-compatible emulator can be marked AWS explicitly.

This matrix describes the S3-compatible surface each provider is expected to
answer. It is not a skip list: `config` reads every section it is asked for on
every provider, and an API the provider does not implement (501/405,
`NotImplemented`) comes back as that section's `provider_unsupported` status.
“No” means this build does not expect that S3 API; it does not mean the
underlying cloud has no such feature outside its S3 endpoint.

| Capability | AWS S3 | Cloudflare R2 | MinIO | Aliyun OSS | GCS interop | Other |
|---|---|---|---|---|---|---|
| Bucket policy | yes | yes | yes | yes | unknown | unknown |
| Policy status API | yes | no | no | no | no | no |
| ACL | yes | no | unknown | yes | unknown | unknown |
| Public access block | yes | no | no | no | no | unknown |
| Object ownership | yes | no | no | no | no | unknown |
| Access logging | yes | no | no | yes | no | no |
| Inventory | yes | no | no | no | no | no |
| Account-level reads (`account`) | yes | no | no | no | no | no |

## How to read it

- **Bucket configuration** is the `config` tool's sections, returned as the API
  answers them. Where a provider has no policy-status API, the policy document
  itself is what the agent reads.
- **Public access block** and **object ownership** are AWS S3 configuration
  APIs. R2 and Aliyun expose policy-level behaviour, not the same switches.
- **Access logging** and **Inventory** are configuration features; an
  unsupported API is a status in the result, not an empty configuration.
- **Account-level reads** — the account-wide public access block, IAM, SCPs,
  KMS key policy, Access Analyzer, CloudWatch storage metrics and CloudTrail —
  run only on an account whose kind is AWS. Any other kind gets
  `provider_unsupported` without a request. Without CloudWatch, `query` can
  measure listed objects instead, and the agent says it measured a listing, not
  the whole bucket.

This matrix is documentation, not code: the app tries every read and reports
the provider's answer. The runtime sources are `src/main/s3/capabilities.ts`
(kind detection) and `s3/status.ts` (how an error becomes a status); `docs/iam.md` lists
the AWS actions the readers call.
