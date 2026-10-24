/**
 * The read that failed tells us the permission to ask for. Only access-denied
 * reads become gaps; a provider that does not implement an API is a capability
 * gap, not a missing IAM action.
 */
import type { BucketFacts } from './facts'

export interface PermissionGap {
  bucket: string
  item: string
  action: string
}

const ACTIONS: { key: keyof BucketFacts; item: string; action: string }[] = [
  { key: 'versioning', item: 'versioning', action: 's3:GetBucketVersioning' },
  { key: 'encryption', item: 'encryption', action: 's3:GetEncryptionConfiguration' },
  { key: 'lifecycle', item: 'lifecycle', action: 's3:GetLifecycleConfiguration' },
  { key: 'replication', item: 'replication', action: 's3:GetReplicationConfiguration' },
  { key: 'policy', item: 'bucket policy', action: 's3:GetBucketPolicy' },
  { key: 'policyStatus', item: 'policy status', action: 's3:GetBucketPolicyStatus' },
  { key: 'pab', item: 'public access block', action: 's3:GetBucketPublicAccessBlock' },
  { key: 'ownership', item: 'object ownership', action: 's3:GetBucketOwnershipControls' },
  { key: 'acl', item: 'ACL', action: 's3:GetBucketAcl' },
  { key: 'cors', item: 'CORS', action: 's3:GetBucketCORS' },
  { key: 'logging', item: 'access logging', action: 's3:GetBucketLogging' },
  { key: 'tagging', item: 'tags', action: 's3:GetBucketTagging' },
  { key: 'notifications', item: 'notifications', action: 's3:GetBucketNotification' },
  {
    key: 'inventory',
    item: 'inventory configuration',
    action: 's3:ListBucketInventoryConfigurations',
  },
]

export function permissionGaps(facts: BucketFacts, access = false): PermissionGap[] {
  const gaps: PermissionGap[] = []
  if (facts.head === 'access_denied')
    gaps.push({ bucket: facts.bucket, item: 'bucket', action: 's3:ListBucket' })
  for (const entry of ACTIONS) {
    const dim = facts[entry.key] as { status?: string } | undefined
    if (dim?.status === 'access_denied')
      gaps.push({ bucket: facts.bucket, item: entry.item, action: entry.action })
  }
  if (access) {
    gaps.push({
      bucket: facts.bucket,
      item: 'identity policies',
      action: 'iam:GetAccountAuthorizationDetails',
    })
    gaps.push({ bucket: facts.bucket, item: 'key policy', action: 'kms:GetKeyPolicy' })
    gaps.push({
      bucket: facts.bucket,
      item: 'Access Analyzer',
      action: 'access-analyzer:ListFindings',
    })
    gaps.push({
      bucket: facts.bucket,
      item: 'service control policies',
      action: 'organizations:ListPoliciesForTarget',
    })
  }
  return gaps.slice(0, 16)
}

export function accessPermissionGaps(
  bucket: string,
  blind: { source: string; status: string }[],
): PermissionGap[] {
  const action: Record<string, string> = {
    iam: 'iam:GetAccountAuthorizationDetails',
    scp: 'organizations:DescribePolicy',
    'scp-parents': 'organizations:ListParents',
    kms: 'kms:GetKeyPolicy',
    'access-analyzer': 'access-analyzer:ListFindings',
  }
  return blind
    .filter((item) => item.status === 'access_denied')
    .flatMap((item) =>
      action[item.source] ? [{ bucket, item: item.source, action: action[item.source]! }] : [],
    )
}

/** The least-privilege read policy; the UI can show exactly what it asked for. */
export const READ_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: [
        's3:ListAllMyBuckets',
        's3:GetBucketLocation',
        's3:ListBucket',
        's3:GetBucketPolicy',
        's3:GetBucketPolicyStatus',
        's3:GetBucketAcl',
        's3:GetBucketCORS',
        's3:GetBucketVersioning',
        's3:GetEncryptionConfiguration',
        's3:GetLifecycleConfiguration',
        's3:GetReplicationConfiguration',
        's3:GetBucketLogging',
        's3:GetBucketOwnershipControls',
        's3:GetBucketPublicAccessBlock',
        's3:GetBucketTagging',
        's3:GetBucketNotification',
        's3:ListBucketInventoryConfigurations',
        's3:GetObject',
      ],
      Resource: '*',
    },
    {
      Effect: 'Allow',
      Action: ['s3:GetAccountPublicAccessBlock'],
      Resource: '*',
    },
    {
      Effect: 'Allow',
      Action: [
        'cloudwatch:GetMetricData',
        'cloudwatch:ListMetrics',
        'cloudtrail:LookupEvents',
        'iam:GetAccountAuthorizationDetails',
        'organizations:ListParents',
        'organizations:ListPoliciesForTarget',
        'organizations:DescribePolicy',
        'kms:DescribeKey',
        'kms:GetKeyPolicy',
        'access-analyzer:ListAnalyzers',
        'access-analyzer:ListFindings',
      ],
      Resource: '*',
    },
  ],
} as const
