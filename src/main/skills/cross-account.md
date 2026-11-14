---

name: cross-account
description: Who outside this account can reach a bucket, its keys or its data — principals in other accounts, the organization, AWS services.
---

Every identifier reaches you as the service returned it, so compare account ids directly.

## Know who "us" is

- `sts GetCallerIdentity` gives this account's id and the caller's ARN.
- `organizations DescribeOrganization` and `ListAccounts` (from the management or a delegated account) let you label other ids as "another account in the same organization" versus "outside the organization". Without access, say the id is unknown.

## Where another account can be granted access

1. **Bucket policy** — every `Principal` whose account id differs from ours: `arn:aws:iam::<id>:root` (the whole account, delegated to its own IAM), a role or user ARN, or a bare id. `aws:PrincipalOrgID` grants the whole organization.
2. **Bucket ACL and object ACLs** — grants to a canonical user id that is not the owner's (`Owner.ID` in `GetBucketAcl`), unless ownership is `BucketOwnerEnforced`.
3. **Access points** — their policies can name other accounts; cross-account access points (`BucketAccountId` differs) exist too.
4. **KMS** — for SSE-KMS buckets, the key policy (`kms GetKeyPolicy`) and grants (`kms ListGrants`) decide who can decrypt. A principal allowed by the bucket but not by the key reads only ciphertext errors; one allowed by the key but not the bucket gets nothing.
5. **Replication** — `GetBucketReplication`: a destination bucket in another account receives copies of the data.
6. **IAM roles in this account trusted by others** — `iam GetAccountAuthorizationDetails` (`Filter: ["Role"]`): roles whose `AssumeRolePolicyDocument` trusts another account and whose policies allow S3 on this bucket give that account access by assuming them.
7. **S3 Access Grants** — `s3control ListAccessGrants` (if an instance exists).
8. **Service principals** — `cloudtrail.amazonaws.com`, `logging.s3.amazonaws.com`, etc. Check they are pinned with `aws:SourceAccount`/`aws:SourceArn`; without them any account's use of that service may write here (confused deputy).

## Simulate when you are unsure

`iam SimulatePrincipalPolicy` evaluates a principal of _this_ account against a resource ARN. For other accounts you can only reason from the resource side; say so.

## A good answer

A table of external principals: account id, inside/outside the organization, what they can do (read, write, decrypt, assume), through which path, and the evidence for each.
