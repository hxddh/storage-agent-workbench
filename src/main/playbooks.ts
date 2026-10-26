/**
 * The field guide the agent can consult when it wants it.
 *
 * These cards used to sit in every system prompt. They are now a tool: the
 * agent asks for one when the question needs it, and the prompt stays about
 * goals, safety and evidence instead of a fixed procedure.
 */
export const PLAYBOOKS: Record<string, string> = {
  access:
    'Access: `config(aspect: "access")` reads the bucket policy and ACL locally, reads IAM principals and policies with GetAccountAuthorizationDetails, evaluates them locally, reads inherited SCPs when Organizations is available, and attaches KMS and Access Analyzer evidence. The view reports principal coverage, undecided conditions and truncation. A denied read is a blind spot, not an empty grant list. Use `query` with `principal` for a principal-first reverse view. Policy and ACL rows are grants, not one merged authorization verdict.',
  changes:
    'Changes: a survey compares this reading with the last remembered posture and names what changed. On AWS it asks CloudTrail who made the change over a 90-day window. A denied or unsupported lookup means the actor is unknown, not that nobody changed it. A truncated lookup is still truncated.',
  history:
    'History: `estate(history: true)` returns the estate Issue events (opened, resolved, recurred, gone, accepted, reopened) and posture changes, newest first. Use `since` for a time window and `bucket` or `code` to narrow it. It is memory, not a fresh read. Reading events are account-wide; a bucket or code filter omits them.',
  inventory:
    'Inventory: when a bucket has S3 Inventory, `inventory` reads the latest manifest and a bounded page, or `full: true` imports every manifest file (CSV or Parquet) into a dataset. It covers objects that ListObjects cannot enumerate cheaply; coverage and the inventory date are explicit. Prefer CloudWatch capacity or a prefix-level listing before paging millions of objects.',
  fix: 'Change plans: `fix` without a bucket or code returns one plan for every open Issue class. Lifecycle rules merge per bucket; a current policy or lifecycle is read before it is replaced. Manual steps name their blocker and residual Issues stay listed. The user applies the text; re-verification is what confirms a step. Never claim a step was applied.',
  capacity:
    'Capacity: on AWS, survey reads CloudWatch daily storage metrics: size by storage class, object count, 14-day growth and a storage-only estimate at us-east-1 list price. Call it an estimate. S3-compatible endpoints publish none; use `query` to measure a bucket there.',
  account:
    'Account posture: survey reads every bucket policy, ACL, public access block, ownership, CORS, logging, encryption and lifecycle, and decides twelve rules. A bucket is public only when the policy or ACL proves it and neither the bucket nor the account public access block cancels it. When a read was blind, exposure is undecided, not no.',
  iam: 'Security and IAM: a wildcard principal is not the same as anonymous access. A condition on source IP, VPC, organization or account narrows it; the local policy reader respects that. Public access block prevents exposure; it does not remove a policy or ACL grant. Service principals, federated identities and some external policies remain outside the enumerated evidence.',
  protocol:
    'Protocol compatibility: S3-compatible providers answer 501 or 405 for configuration APIs they do not implement. That is a capability gap, not a clean result. Where the provider has no policy-status API, the policy document itself is evaluated. Report the gap instead of turning it into "not configured".',
  logs: 'Access logs: parse an attached S3, CloudFront or ALB log, then aggregate. Status classes, bytes and latency percentiles are the evidence; raw rows stay out of the answer. State the time window and the number of rows read.',
  lifecycle:
    'Lifecycle and cost: no AbortIncompleteMultipartUpload leaves parts billing forever. Versioning without NoncurrentVersionExpiration grows storage without bound. A lifecycle put replaces the whole configuration, so a generated fix must be merged, not applied blind. Cache-control, replication and object-lock rules can be equally destructive to replace.',
}

export const PLAYBOOK_NAMES = Object.keys(PLAYBOOKS)
