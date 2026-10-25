# Read-only IAM

Storage Agent never executes a write action. This policy covers the read APIs
the current build calls. Every statement is optional: a missing permission
becomes a named blind spot, not a clean result. `s3:GetObject` is also used to
read an S3 Inventory manifest and its object files; `s3:GetObjectAcl` and
`s3:GetObjectTagging` are needed only for those object aspects.

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
        "s3:ListBucketVersions",
        "s3:ListBucketMultipartUploads",
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
      "Sid": "ReadObjectDataAndInventory",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAcl",
        "s3:GetObjectTagging"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadAccountPosture",
      "Effect": "Allow",
      "Action": [
        "s3:GetAccountPublicAccessBlock"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadEvidence",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData",
        "cloudtrail:LookupEvents",
        "iam:GetAccountAuthorizationDetails",
        "organizations:ListParents",
        "organizations:ListPoliciesForTarget",
        "organizations:DescribePolicy",
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

`sts:GetCallerIdentity` is called to obtain the account id for the account-wide
block and SCP lookup. It is an identity call, not an IAM permission, and the id
is dropped after the call. Narrowing `Resource` to the configured buckets and
objects is compatible with the app's scope, but it is the user's choice.

## What each block enables

| Statement | Enables | When it is missing |
|---|---|---|
| `s3:ListAllMyBuckets` | the account survey's bucket list | the survey cannot start |
| `s3:GetBucket*`, `ListBucketVersions`, `ListBucketMultipartUploads` | posture, exposure, lifecycle, logging, tags, versions and uploads | the matching rule or object question is undecided; the brief names the action |
| `s3:GetObject` | object metadata and a bounded preview; inventory manifest/files | object and inventory questions stay open |
| `s3:GetObjectAcl`, `s3:GetObjectTagging` | those two object aspects | the object view says the aspect is not readable |
| `s3:GetAccountPublicAccessBlock` | the account-wide block, S3.1 | account block is unknown, never assumed off |
| `cloudwatch:GetMetricData` | size, objects and storage-class mix | capacity is unavailable, not zero |
| `cloudtrail:LookupEvents` | who changed a bucket | the change is shown with the actor unknown |
| `iam:GetAccountAuthorizationDetails` | identity, group, managed-policy, boundary and trust evaluation | IAM is a blind spot; policy and ACL grants still show |
| `organizations:ListParents`, `organizations:ListPoliciesForTarget`, `organizations:DescribePolicy` | SCPs inherited from the account, OUs and root | SCPs are a blind spot; identity grants still show |
| `kms:DescribeKey`, `kms:GetKeyPolicy` | the key policy for SSE-KMS | the key policy is a blind spot |
| `access-analyzer:ListAnalyzers`, `access-analyzer:ListFindings` | Access Analyzer findings | findings are unavailable; local policy reading still runs |

## Boundaries

- Scope (`provider.scope.buckets`) is enforced before every bucket read. IAM is
  not an authorization shortcut: a broad IAM policy does not make the app read
  buckets outside the configured list.
- `@` context in the composer is focus only. It cannot grant access.
- The app never stores an account id. ARNs in views and model text are redacted
  to `<account>` before they leave the reading.
- The model sees bounded, redacted tool output, not a raw policy document. A
  generated fix is text; applying it needs credentials the app does not use.
- Access analysis is evidence, not an authorization decision. A list can be
  incomplete because a principal was not enumerated, a condition was not
  evaluated, or a read was denied; the page says so.
