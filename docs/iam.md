# Read-only IAM

Storage Agent never asks for a write action. This is the complete policy the
product can use; every statement is optional, and a missing one becomes a named
blind spot instead of a clean result.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadBucketConfiguration",
      "Effect": "Allow",
      "Action": [
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:GetBucketPolicy",
        "s3:GetBucketPolicyStatus",
        "s3:GetBucketAcl",
        "s3:GetBucketCORS",
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:GetReplicationConfiguration",
        "s3:GetBucketLogging",
        "s3:GetBucketOwnershipControls",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketTagging",
        "s3:GetBucketNotification",
        "s3:ListBucketInventoryConfigurations"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadObjectMetadata",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "*"
    },
    {
      "Sid": "ReadAccountPosture",
      "Effect": "Allow",
      "Action": "s3:GetAccountPublicAccessBlock",
      "Resource": "*"
    },
    {
      "Sid": "ReadEvidence",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData",
        "cloudwatch:ListMetrics",
        "cloudtrail:LookupEvents",
        "iam:ListUsers",
        "iam:ListRoles",
        "iam:SimulatePrincipalPolicy",
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
        "access-analyzer:ListAnalyzers",
        "access-analyzer:ListFindings"
      ],
      "Resource": "*"
    }
  ]
}
```

## What each statement enables

| Statement | Enables | When it is missing |
|---|---|---|
| `s3:ListAllMyBuckets` | the account survey's bucket list | the survey cannot start |
| `s3:GetBucket*` | posture, exposure, lifecycle, logging, tags | the matching rule is undecided; the brief names the action |
| `s3:GetObject` | object metadata and a bounded preview | object questions stay open |
| `s3:GetAccountPublicAccessBlock` | the account-wide block, S3.1 | account block is unknown, never assumed off |
| `cloudwatch:*` | size, objects and storage-class mix | capacity is unavailable, not zero |
| `cloudtrail:LookupEvents` | who changed a bucket | the change is shown with the actor unknown |
| `iam:ListUsers`, `iam:ListRoles`, `iam:SimulatePrincipalPolicy` | identity grants in an access path | IAM is a blind spot; policy and ACL grants still show |
| `kms:DescribeKey`, `kms:GetKeyPolicy` | the key policy for SSE-KMS | the key policy is a blind spot |
| `access-analyzer:*` | Access Analyzer findings | findings are unavailable; local policy reading still runs |

## Boundaries

- Scope (`provider.scope.buckets`) is enforced before every bucket read. IAM is
  not an authorization shortcut: a broad IAM policy does not make the app read
  buckets outside the configured list.
- `@` context in the composer is focus only. It cannot grant access.
- The app never stores an account id. ARNs in views and model text are redacted
  to `<account>` before they leave the reading.
- Access analysis is evidence, not an authorization decision. A list can be
  incomplete because a principal was not enumerated or a read was denied; the
  page says so.
