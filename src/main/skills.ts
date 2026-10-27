/**
 * Four methods, not eleven reference cards.
 *
 * A skill is a workflow the model can load when the question needs it. The
 * runtime gives the model a short index; the full text stays out of every
 * prompt until it is requested. Skills are documentation, never storage reads.
 */
export interface Skill {
  name: string
  title: string
  description: string
  body: string
}

export const SKILLS: Record<string, Skill> = {
  access: {
    name: 'access',
    title: 'Access evidence',
    description: 'Who can reach a bucket, what was not read, and why it is not one verdict.',
    body: 'Access: `config(aspect: "access")` reads bucket policy and ACL locally, reads IAM principals and policies, inherited SCPs when Organizations permits, KMS key policy and Access Analyzer evidence. The view reports principal coverage, undecided conditions and truncation. A denied read is a blind spot, not an empty grant list. Use `query` with `principal` for a principal-first reverse view. Policy and ACL rows are grants, not one merged authorization verdict; service principals, federated identities and some external policies remain outside the enumerated evidence.',
  },
  change: {
    name: 'change',
    title: 'Change planning',
    description: 'Lifecycle, policy and cost changes that are merged, blocked or left manual.',
    body: 'Change planning: `change_plan` returns one deterministic change plan. Lifecycle rules merge per bucket; a current policy or lifecycle is read before it is replaced. A policy containing an account id is not reproduced in the window. A manual step names its blocker, residual Issues stay listed, and the user applies the text. Never claim a step was applied; only re-verification can confirm it. No AbortIncompleteMultipartUpload leaves parts billing forever; versioning without NoncurrentVersionExpiration grows storage without bound. A lifecycle put replaces the whole configuration, so it must be merged, not applied blind.',
  },
  inventory: {
    name: 'inventory',
    title: 'Inventory and logs',
    description: 'Prefixes, stale objects, versions, S3 Inventory and attached logs.',
    body: 'Inventory: use `query` for questions over many objects or buckets. `list` is one bounded page; use S3 Inventory or a prefix-level listing before paging millions of objects. `inventory` reads the latest manifest and one page, or imports every manifest file into a local dataset with bounded coverage and an explicit inventory date. Attached logs and inventories are imported with `dataset`; only whitelisted aggregates are allowed. State the time window and number of rows read. A truncated page or import is not an exhaustive answer.',
  },
  capacity: {
    name: 'capacity',
    title: 'Capacity and cost',
    description: 'Storage size, growth, class mix and a clearly labelled list-price estimate.',
    body: 'Capacity: on AWS, `survey` reads CloudWatch daily storage metrics: size by storage class, object count, 14-day growth and a storage-only estimate at us-east-1 list price. Call it an estimate, not a bill; requests, transfer, retrieval and other charges are outside it. S3-compatible endpoints publish none; use `query` to measure a bucket there. Capacity is remembered in the bucket posture so a later answer can say how old it is.',
  },
}

export const SKILL_NAMES = Object.keys(SKILLS)
