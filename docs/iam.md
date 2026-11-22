# IAM

Storage Agent reads with the account's credentials and writes only when the
user approves a change on an account that allows changes. There is no fixed
list of reads: `call` (`s3/api.ts`) can run any operation of a bundled service
whose name starts with Get, List, Head, Describe, Lookup, Search, Select,
Simulate or BatchGet. The bundled clients are S3, S3 Control, STS, IAM,
Organizations, KMS, Access Analyzer, CloudWatch, CloudTrail, Config,
CloudFront, Backup, Security Hub, GuardDuty, SNS and SQS. Services whose reads
return secrets or run compute (Lambda, EC2, Secrets Manager, SSM, ECR,
DynamoDB) are not bundled. The exceptions are STS `GetSessionToken`,
`GetFederationToken`, `GetWebIdentityToken`, `GetDelegatedAccessToken`, KMS
`GetParametersForImport` and S3 Control `GetDataAccess`. What the agent can
actually read is what the account's credentials allow.

Every permission is optional. A denied call comes back as the service's error,
for example `AccessDenied (HTTP 403): …`, the step stays in the conversation,
and the agent says what it could not read. A denied read is never shown as an
empty configuration.

## Suggested read policies

The simplest read-only grant is the AWS managed policy `ReadOnlyAccess`. It
covers every read the app can make, and more services than it bundles. It also
allows `s3:GetObject` on every object; narrow it if the agent should not read
object bodies.

A narrower policy for storage questions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3Read",
      "Effect": "Allow",
      "Action": [
        "s3:ListAllMyBuckets",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:ListBucketMultipartUploads",
        "s3:GetBucket*",
        "s3:Get*Configuration",
        "s3:GetAccountPublicAccessBlock",
        "s3:GetObject",
        "s3:GetObjectAcl",
        "s3:GetObjectTagging",
        "s3:GetObjectVersion"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AccountRead",
      "Effect": "Allow",
      "Action": [
        "iam:Get*",
        "iam:List*",
        "iam:SimulatePrincipalPolicy",
        "organizations:Describe*",
        "organizations:List*",
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
        "kms:ListKeys",
        "kms:ListAliases",
        "access-analyzer:List*",
        "access-analyzer:Get*",
        "cloudwatch:GetMetricData",
        "cloudwatch:ListMetrics",
        "cloudtrail:LookupEvents",
        "cloudtrail:DescribeTrails"
      ],
      "Resource": "*"
    }
  ]
}
```

Add permissions for the other bundled services only when the agent should
read them; `ReadOnlyAccess` covers them all. Drop the `AccountRead` statement
to keep the agent to S3. Drop `s3:GetObject` and `s3:GetObjectVersion` to keep
it off object bodies; S3 Inventory import (`query`'s `inventory()`) then needs
`s3:GetObject` on the inventory destination only. Narrowing `Resource` to the
configured buckets and objects is compatible with the app's scope; it is the
user's choice.

`sts:GetCallerIdentity` is called when an input says `<account>` and for an S3
Control call that leaves out `AccountId`, to fill in the account id. It needs
no IAM permission. The id is used for that call only and never returned.

## Approved changes

Writes need permissions only when the account allows changes (Settings →
Storage accounts → *Allow changes I approve*, off by default). An approved
change runs with the account's **AWS profile for changes** when one is set,
else with the account's own credentials. A separate profile lets the read
identity stay read-only: give the write permissions to the change profile
only.

Before a change is proposed, the app reads what it would replace with the
account's read credentials, so the read identity needs the matching read:
the read policy above covers every one. The change itself, and a roll back,
need these actions on the write identity:

| Proposed operation (`change`) | IAM action | Rolled back with |
|---|---|---|
| s3 `PutPublicAccessBlock`, `DeletePublicAccessBlock` | `s3:PutBucketPublicAccessBlock` | the same |
| s3 `PutBucketPolicy` | `s3:PutBucketPolicy` | `s3:PutBucketPolicy` or `s3:DeleteBucketPolicy` |
| s3 `DeleteBucketPolicy` | `s3:DeleteBucketPolicy` | `s3:PutBucketPolicy` |
| s3 `PutBucketOwnershipControls` | `s3:PutBucketOwnershipControls` | the same (also for `DeleteBucketOwnershipControls`) |
| s3 `PutBucketEncryption` | `s3:PutEncryptionConfiguration` | the same (also for `DeleteBucketEncryption`) |
| s3 `PutBucketVersioning` | `s3:PutBucketVersioning` | the same |
| s3 `PutBucketLifecycleConfiguration`, `DeleteBucketLifecycle` | `s3:PutLifecycleConfiguration` | the same |
| s3 `PutBucketCors`, `DeleteBucketCors` | `s3:PutBucketCORS` | the same |
| s3 `PutBucketLogging` | `s3:PutBucketLogging` | the same |
| s3 `PutBucketTagging` | `s3:PutBucketTagging` | the same (also for `DeleteBucketTagging`) |
| s3 `PutBucketAcl` | `s3:PutBucketAcl` | the same |
| s3control `PutPublicAccessBlock` | `s3:PutAccountPublicAccessBlock` | the same (also for `DeletePublicAccessBlock`) |

A policy for a change profile that may make every change the app offers:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ApprovedBucketConfiguration",
      "Effect": "Allow",
      "Action": [
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketOwnershipControls",
        "s3:PutEncryptionConfiguration",
        "s3:PutBucketVersioning",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketCORS",
        "s3:PutBucketLogging",
        "s3:PutBucketTagging",
        "s3:PutBucketAcl"
      ],
      "Resource": "arn:aws:s3:::*"
    },
    {
      "Sid": "ApprovedAccountPublicAccessBlock",
      "Effect": "Allow",
      "Action": "s3:PutAccountPublicAccessBlock",
      "Resource": "*"
    }
  ]
}
```

Leave out any action the agent should not be able to propose successfully;
the approved call then fails with the service's `AccessDenied`, which the
agent is told. Narrow `Resource` to the buckets changes may touch. An S3
Control change also calls `sts:GetCallerIdentity` with the write identity to
fill in the account id.

## Where each call goes

On an AWS account (no custom endpoint) each service is called in the region
the agent names or the account's region; IAM and Organizations always use
`us-east-1`. An approved change uses the account's region. A custom-endpoint
account sends every service, and every approved change, to its own endpoint
and never to AWS, so its credentials do not reach AWS.

## Boundaries

- Scope (`scope.buckets`) is authorization: on a scoped account every call
  names an in-scope bucket, is a bucket listing filtered to the scope, or
  reveals no bucket; services that see across the account (IAM, CloudTrail,
  Config, CloudWatch…) do not run. A change must name an in-scope bucket, and
  the account-wide public access block cannot be changed on a scoped account.
  A broad IAM policy does not make the app read or change buckets outside the
  configured list.
- `@` context in the composer is focus only. It cannot grant access.
- Account ids and access key ids are identifiers and are shown as the
  services return them; secret keys, session tokens and signatures are
  redacted before they leave the main process.
- `call` refuses any operation that is not a read, whatever the credentials
  allow. `change` refuses anything off its allowlist — object writes, deletes
  of data, IAM — whatever the change profile allows. A change outside the
  allowlist is text for the user to apply with their own tools.
