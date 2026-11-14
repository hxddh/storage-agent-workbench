---

name: cost-and-lifecycle
description: How much is stored, in which storage classes, what is growing, and what lifecycle rules could save.
---

## Size without listing everything

- CloudWatch daily storage metrics, in the bucket's region: `cloudwatch GetMetricData` with namespace `AWS/S3`, metric `BucketSizeBytes` (dimensions `BucketName`, `StorageType` such as `StandardStorage`, `StandardIAStorage`, `GlacierStorage`, `IntelligentTieringFAStorage`…) and `NumberOfObjects` (`StorageType: AllStorageTypes`), period 86400. Data lags a day.
- S3 Storage Lens (`s3control ListStorageLensConfigurations`) gives account-wide views if configured.
- An S3 Inventory report (`GetBucketInventoryConfiguration`, then `query` → `inventory({bucket})`) has every object with size, class, last modified, version flags — the right tool for buckets with millions of objects. Then `sql` over it.
- For smaller buckets, page `ListObjectsV2` in a `query` and aggregate by prefix and `StorageClass`.

## Where money hides

- Noncurrent versions in versioned buckets (`ListObjectVersions`, or inventory with `IsLatest`).
- Incomplete multipart uploads (`ListMultipartUploads`) — invisible in listings, billed as storage.
- Small objects in IA/Glacier classes (minimum billable size 128 KB, minimum duration 30/90/180 days).
- Data never read: access logs or CloudTrail data events tell you what is read; without them, `LastModified` is only a proxy — say so.

## Lifecycle

`GetBucketLifecycleConfiguration` (`NoSuchLifecycleConfiguration` = none), `GetBucketIntelligentTieringConfiguration`/`ListBucketIntelligentTieringConfigurations`. Propose rules that match the data's real age profile, with the expected effect computed from what you read; prices vary by region — state the ones you assume.
