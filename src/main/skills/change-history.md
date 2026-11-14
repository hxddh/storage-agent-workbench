---

name: change-history
description: What changed on a bucket or its objects, when, and who did it.
---

## Management events (bucket configuration)

`cloudtrail LookupEvents` covers the last 90 days of management events **in the region you call** — call the bucket's region (`GetBucketLocation`; `null`/empty means us-east-1). Filter with `LookupAttributes: [{AttributeKey: "ResourceName", AttributeValue: "<bucket>"}]` or `EventName`. Useful names: `PutBucketPolicy`, `DeleteBucketPolicy`, `PutBucketAcl`, `PutBucketPublicAccessBlock`, `DeleteBucketPublicAccessBlock`, `PutBucketEncryption`, `PutBucketOwnershipControls`, `PutBucketLifecycleConfiguration`, `PutBucketReplication`, `CreateBucket`, `DeleteBucket`. Account-level block changes are `PutAccountPublicAccessBlock` (s3control). The `CloudTrailEvent` field is a JSON string with `userIdentity`, `sourceIPAddress`, `userAgent` and `requestParameters` — parse it in a `query`.

LookupEvents pages slowly (about 2 requests per second); use `StartTime`/`EndTime` and `NextToken`.

## Data events (object reads and writes)

LookupEvents does **not** return data events (GetObject, PutObject, DeleteObject). They exist only if a trail logs them: `cloudtrail DescribeTrails`, `GetEventSelectors {TrailName}`. Their logs are objects in the trail's bucket (`AWSLogs/<account>/CloudTrail/<region>/YYYY/MM/DD/…json.gz`) — import a day with `query` → `dataset({bucket, prefix})`. S3 server access logs (`GetBucketLogging`) are the other source; `dataset` parses their format.

## Configuration history

`config GetResourceConfigHistory {resourceType: "AWS::S3::Bucket", resourceId: "<bucket>"}` gives point-in-time configurations if AWS Config records S3 — the diff between two items is often the clearest "what changed".

## Object history

Versioned buckets: `ListObjectVersions {Bucket, Prefix}` shows every version and delete marker with `LastModified`. Unversioned buckets keep no history; say so.

## A good answer

A timeline (`render` has a timeline block) of changes with who, from where and the exact request, and what the current state is.
