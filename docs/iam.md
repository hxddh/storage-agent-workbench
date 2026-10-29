# Read-only IAM

Storage Agent never executes a write action. There is no fixed list of reads:
`call` (`s3/api.ts`) can run any operation of a bundled service (S3, S3
Control, STS, IAM, Organizations, KMS, Access Analyzer, CloudWatch,
CloudTrail) whose name starts with Get, List, Head, Describe, Lookup, Search,
Select or Simulate, except STS `GetSessionToken`, `GetFederationToken`,
`GetWebIdentityToken` and KMS `GetParametersForImport`. What the agent can
actually read is what the account's credentials allow.

Every permission is optional. A denied call comes back as the service's error,
for example `AccessDenied (HTTP 403): …`, the step stays in the conversation,
and the agent says what it could not read. A denied read is never shown as an
empty configuration.

## Suggested policies

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

Drop the `AccountRead` statement to keep the agent to S3. Drop `s3:GetObject`
and `s3:GetObjectVersion` to keep it off object bodies; S3 Inventory import
(`query`'s `inventory()`) then needs `s3:GetObject` on the inventory
destination only. Narrowing `Resource` to the configured buckets and objects is
compatible with the app's scope; it is the user's choice.

`sts:GetCallerIdentity` is called when an input says `<account>` and for every
S3 Control call, to fill in the account id. It needs no IAM permission, and the
id is used for that call only, never returned.

## Where each read goes

On an AWS account (no custom endpoint) each service is called in the region
the agent names or the account's region; IAM and Organizations always use
`us-east-1`. A custom-endpoint account sends every service to its own endpoint
and never to AWS, so its credentials do not reach AWS.

## Boundaries

- Scope (`provider.scope.buckets`) is checked before any S3 or S3 Control call
  that names a bucket, and `ListBuckets` is filtered to it. IAM is not an
  authorization shortcut: a broad IAM policy does not make the app read
  buckets outside the configured list. Reads of other services are not
  filtered by bucket.
- `@` context in the composer is focus only. It cannot grant access.
- The app never stores or shows an account id. Every response is scrubbed to
  `<account>`, and ARNs in any text are redacted before they leave the main
  process.
- A change the agent writes is text. Applying it needs write permissions the
  app neither asks for nor uses; `call` refuses any operation that is not a
  read, whatever the credentials allow.
