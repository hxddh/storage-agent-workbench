---

name: public-access
description: Whether a bucket or its objects can be read or written by anyone on the internet, and through which path.
---

Public access has several independent paths. A bucket is reachable by anyone if **any one** path is open and nothing above it blocks it. Read every layer before you answer; one "not public" signal is not the answer.

## The layers, top down

1. **Account Block Public Access** — `s3control GetPublicAccessBlock` (AccountId is filled in). `NoSuchPublicAccessBlockConfiguration` means no account block.
2. **Bucket Block Public Access** — `s3 GetPublicAccessBlock {Bucket}`. The effective setting is the OR of account and bucket for each of the four flags:
   - `BlockPublicAcls` / `IgnorePublicAcls` neutralise ACL grants.
   - `BlockPublicPolicy` stops new public policies; `RestrictPublicBuckets` makes an existing public policy reachable only by AWS service principals and the owner account.
3. **Bucket policy** — `s3 GetBucketPolicyStatus {Bucket}` is S3's own evaluation (`IsPublic`). Then read the policy itself (`GetBucketPolicy`) to say _what_ is open: `Principal: "*"` or `{"AWS": "*"}` with `Allow`, and whether conditions narrow it (`aws:SourceVpce`, `aws:SourceVpc`, `aws:SourceIp`, `aws:PrincipalOrgID`, `aws:PrincipalAccount`, `aws:SourceArn`/`aws:SourceAccount` for a service principal). A condition on an IP range open to the internet (`0.0.0.0/0`) is still public. `NoSuchBucketPolicy` is an answer: no policy.
4. **Object Ownership and ACLs** — `GetBucketOwnershipControls`. `BucketOwnerEnforced` disables ACLs entirely. Otherwise read `GetBucketAcl`: grants to `http://acs.amazonaws.com/groups/global/AllUsers` (anyone) or `AuthenticatedUsers` (any AWS account — also public). Object ACLs can be public even when the bucket ACL is not: sample objects with `GetObjectAcl` when ownership is not enforced and ACLs are not ignored.
5. **Access points** — `s3control ListAccessPoints {Bucket}`; each has its own policy (`GetAccessPointPolicy`, `GetAccessPointPolicyStatus`), its own block (`PublicAccessBlockConfiguration` in `GetAccessPoint`) and a `NetworkOrigin` (VPC-only cannot be public). Multi-Region Access Points: `ListMultiRegionAccessPoints`.
6. **Website hosting** — `GetBucketWebsite`. A website endpoint serves only what the policy/ACL makes public, but it is how people usually reach it.
7. **CloudFront** — `cloudfront ListDistributions`; an origin whose `DomainName` is the bucket. With Origin Access Control (`OriginAccessControlId`) or an OAI the bucket can be private and the content still public through the distribution — say so; that is often intended.

## Verify from outside

`probe` sends an unsigned request — what an anonymous user gets:
- `GET https://<bucket>.s3.<region>.amazonaws.com/` (listing) and `GET …/<key>` for a known key. `200` is public, `403 AccessDenied` is not public for that request.
- The website endpoint and the CloudFront domain for content served there.
  A probe result is the strongest evidence you can give; cite it.

## Access Analyzer

`accessanalyzer ListAnalyzers`, then `ListFindings` filtered on `resourceType = AWS::S3::Bucket` gives AWS's own view of public and cross-account access, if an analyzer exists.

## A good answer

Say which path is open (or that every path is closed and why), what an anonymous user can do (list, read, write), the evidence for each layer, and the smallest change that closes it without breaking intended use (e.g. CloudFront with OAC instead of a public policy).
