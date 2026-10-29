# Read-only IAM

Storage Agent never executes a write action. This policy covers exactly the
read APIs the current build calls (`s3/raw.ts`, `tools/browse.ts`,
`tools/probe.ts`, `tools/query.ts`, `tools/account.ts`). Every statement is
optional: a missing permission comes back as an `access_denied` section or read
(`config`, `account`) or a failed step with the provider's error (the other
tools), and the agent says what it could not read.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListAndBucketConfiguration",
      "Effect": "Allow",
      "Action": [
        "s3:ListAllMyBuckets",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:ListBucketMultipartUploads",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy",
        "s3:GetBucketPolicyStatus",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketAcl",
        "s3:GetBucketOwnershipControls",
        "s3:GetEncryptionConfiguration",
        "s3:GetBucketVersioning",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:GetReplicationConfiguration",
        "s3:GetBucketCORS",
        "s3:GetBucketWebsite",
        "s3:GetBucketLogging",
        "s3:GetBucketNotification",
        "s3:GetInventoryConfiguration",
        "s3:GetBucketTagging"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadObjectsAndInventory",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAcl",
        "s3:GetObjectTagging"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadAccountLevel",
      "Effect": "Allow",
      "Action": [
        "s3:GetAccountPublicAccessBlock",
        "iam:GetAccountAuthorizationDetails",
        "organizations:ListParents",
        "organizations:ListPoliciesForTarget",
        "organizations:DescribePolicy",
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
        "access-analyzer:ListAnalyzers",
        "access-analyzer:ListFindings",
        "cloudwatch:GetMetricData",
        "cloudtrail:LookupEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

`sts:GetCallerIdentity` is called to obtain the account id for the account-wide
block and the SCP lookup. It needs no IAM permission, and the id is used for
those requests only, never returned. Narrowing `Resource` to the configured
buckets and objects is compatible with the app's scope, but it is the user's
choice.

## What each action enables

| Action | API | Used by |
|---|---|---|
| `s3:ListAllMyBuckets` | ListBuckets | `buckets`, `query` `buckets()`, `probe` latency, the `@` menu |
| `s3:ListBucket` | ListObjectsV2, HeadBucket | `objects`, `query` `list()` and inventory manifests, `probe` location and addressing |
| `s3:ListBucketVersions` | ListObjectVersions | `objects` and `list()` with `kind: versions` |
| `s3:ListBucketMultipartUploads` | ListMultipartUploads | `objects` and `list()` with `kind: uploads` |
| `s3:GetObject` | HeadObject, GetObject (ranged) | `object` head and preview, `query` `head()`, inventory manifest and files |
| `s3:GetObjectAcl`, `s3:GetObjectTagging` | GetObjectAcl, GetObjectTagging | `object` `acl` and `tags` aspects |
| `s3:GetBucketLocation` | GetBucketLocation | every `config` read (the `location` section and the regional client) |
| the other `s3:GetBucket*` / `s3:Get*Configuration` actions | one `config` section each | `config` and `query` `config()` |
| `s3:GetInventoryConfiguration` | ListBucketInventoryConfigurations | the `inventory` section and `query` `inventory()` |
| `s3:GetAccountPublicAccessBlock` | S3 Control GetPublicAccessBlock | `account` `public_access_block` |
| `iam:GetAccountAuthorizationDetails` | the same | `account` `iam` |
| `organizations:ListParents`, `ListPoliciesForTarget`, `DescribePolicy` | the same | `account` `scps` |
| `kms:DescribeKey`, `kms:GetKeyPolicy` | the same | `account` `kms_key_policy` |
| `access-analyzer:ListAnalyzers`, `ListFindings` | the same | `account` `access_analyzer` |
| `cloudwatch:GetMetricData` | the same | `account` `storage_metrics` |
| `cloudtrail:LookupEvents` | the same | `account` `cloudtrail` |

A denied read is reported as denied, never as an empty configuration.

## Boundaries

- Scope (`provider.scope.buckets`) is enforced before every bucket read. IAM is
  not an authorization shortcut: a broad IAM policy does not make the app read
  buckets outside the configured list.
- `@` context in the composer is focus only. It cannot grant access.
- The app never stores or shows an account id. Values from `config` and
  `account` are scrubbed to `<account>`, and ARNs in any text are redacted
  before they leave the main process.
- The model sees bounded, redacted tool output. A change the agent writes is
  text; applying it needs permissions this policy does not grant and the app
  does not use.
