# Provider capabilities

The provider is selected per account (Auto reads the endpoint, or choose
explicitly in Settings). The app still attempts a read when a provider is
unknown; a 501 becomes `provider_unsupported`, and the access path labels the
blind spot. This table is what the UI and the method cards promise.

| Capability | AWS S3 | Cloudflare R2 | MinIO | Aliyun OSS | GCS interop | Other |
|---|---|---|---|---|---|---|
| Bucket policy | yes | yes | yes | yes | unknown | unknown |
| Policy status | yes | no (local evaluation) | no (local evaluation) | no (local evaluation) | no | no |
| ACL | yes | no | unknown | yes | unknown | unknown |
| Public access block | yes | no (policy only) | no | no (policy only) | no | unknown |
| Object ownership | yes | no | no | no | no | unknown |
| Access logging | yes | no | no | yes | unknown | unknown |
| Inventory | yes | no | no | no | no | unknown |
| Account public access block | yes | no | no | no | no | no |
| CloudWatch capacity | yes | no | no | no | no | no |
| CloudTrail | yes | no | no | no | no | no |
| IAM evaluation | yes | no | no | no | no | no |
| KMS key policy | yes | no | no | no | no | no |
| Access Analyzer | yes | no | no | no | no | no |

"unknown" is deliberate: the app attempts the API and reports the truth. "no"
means the provider has no such concept, so the matching rule is not a problem
it can have. An access path still shows bucket policy and ACL grants where they
exist.
