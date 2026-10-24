/**
 * One reading of one bucket.
 *
 * Every tool that looks at a bucket's configuration — the account survey and the
 * single-bucket review — reads through `readBucket()` and gets the same typed
 * facts. Rules decide from facts (`estate/rules.ts`), never from finding titles,
 * so a survey and a review can never disagree about the same configuration.
 *
 * Each dimension carries its read status. `unread` means the aspect was not
 * asked for; a blind status (denied, unsupported, error) leaves every rule that
 * needs it undecided.
 */
import {
  GetBucketAclCommand,
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketLoggingCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketPolicyStatusCommand,
  GetBucketReplicationCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  ListBucketInventoryConfigurationsCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { AccountFacts } from './account'
import type { Capacity } from './metrics'
import { evaluatePolicy, type PolicyFacts, policyIsPublic } from './policy'
import { classify, isAbort, type ReadStatus, read } from './status'

export type Aspect = 'security' | 'lifecycle' | 'observability'

export interface Dim<T> {
  status: ReadStatus
  value: T | null
}

export interface PublicAccessBlock {
  blockPublicAcls: boolean
  ignorePublicAcls: boolean
  blockPublicPolicy: boolean
  restrictPublicBuckets: boolean
}

/** What proved exposure, cancelled it, or left it open; worded by the rules in the user's language. */
export type ExposureReason =
  | 'status_public'
  | 'policy_write'
  | 'policy_read'
  | 'policy_list'
  | 'policy_unknown'
  | 'acl_everyone'
  | 'acl_authenticated'
  | 'acl_unknown'
  | 'restrict_blocks'
  | 'ignore_blocks'
  | 'account_restrict_blocks'
  | 'account_ignore_blocks'
  | 'account_block_unread'
  | 'not_read'

export interface Exposure {
  /** true: proved public; false: proved not public; null: a read was blind. */
  verdict: boolean | null
  reasons: ExposureReason[]
}

export interface BucketFacts {
  bucket: string
  region: string
  /** An AWS account, where AWS-only APIs and rules apply; false for an S3-compatible endpoint. */
  aws: boolean
  head: ReadStatus
  versioning: Dim<{ enabled: boolean; suspended: boolean }>
  encryption: Dim<{ algorithm: string | null; keyArn: string | null }>
  lifecycle: Dim<{
    rules: number
    abortMpu: boolean
    expiration: boolean
    transition: boolean
    noncurrentExpiration: boolean
  }>
  replication: Dim<{ rules: number }>
  policy: Dim<PolicyFacts>
  policyStatus: Dim<{ isPublic: boolean }>
  pab: Dim<PublicAccessBlock>
  ownership: Dim<{ mode: string | null }>
  acl: Dim<{ allUsers: boolean; authenticatedUsers: boolean; write: boolean }>
  cors: Dim<{ rules: number; allOrigins: boolean }>
  logging: Dim<{ enabled: boolean }>
  tagging: Dim<{ count: number }>
  notifications: Dim<{ targets: number }>
  inventory: Dim<{ count: number }>
  /** The account-wide public access block, read once per survey. */
  account: AccountFacts
  /** CloudWatch capacity, when the account publishes it. */
  capacity: Capacity | null
  exposure: Exposure
}

const ALL_USERS = 'http://acs.amazonaws.com/groups/global/AllUsers'
const AUTH_USERS = 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers'

const UNREAD = { status: 'unread' as ReadStatus, value: null }

/** A configuration read whose absence means "not configured". */
async function dim<R, T>(call: () => Promise<R>, project: (data: R) => T | null): Promise<Dim<T>> {
  const result = await read(call)
  if (result.status !== 'available') return { status: result.status, value: null }
  const value = project(result.data as R)
  return value === null ? { status: 'not_configured', value: null } : { status: 'available', value }
}

export interface ReadOptions {
  aspects: ReadonlySet<Aspect>
  signal?: AbortSignal
  /** The client for a bucket's own region, when the account spans regions. */
  regional?: (region: string) => S3Client
  defaultRegion: string
  aws?: boolean
  account?: AccountFacts
  capacity?: Capacity | null
}

export async function readBucket(
  base: S3Client,
  bucket: string,
  options: ReadOptions,
): Promise<BucketFacts> {
  const signal = options.signal
  const send = <T>(client: S3Client, command: unknown) =>
    client.send(command as never, { abortSignal: signal }) as Promise<T>

  let head: ReadStatus = 'available'
  try {
    await send(base, new HeadBucketCommand({ Bucket: bucket }))
  } catch (error) {
    if (isAbort(error)) throw error
    head = classify(error)
    // HeadBucket has no body; a 404 is the only way it says the bucket is gone.
    if (head === 'error' && (error as { name?: string })?.name === 'NotFound') head = 'missing'
  }

  const location = await read(() =>
    send<{ LocationConstraint?: string }>(base, new GetBucketLocationCommand({ Bucket: bucket })),
  )
  const region =
    location.status === 'available'
      ? location.data?.LocationConstraint || 'us-east-1'
      : options.defaultRegion
  const client =
    options.regional && region !== options.defaultRegion ? options.regional(region) : base
  const c =
    <T>(command: unknown) =>
    () =>
      send<T>(client, command)

  const security = options.aspects.has('security')
  const lifecycleWanted = options.aspects.has('lifecycle')
  const observability = options.aspects.has('observability')

  const [
    versioning,
    encryption,
    lifecycle,
    replication,
    policyRead,
    policyStatus,
    pab,
    ownership,
    cors,
    logging,
    tagging,
    notifications,
    inventory,
  ] = await Promise.all([
    security || lifecycleWanted
      ? dim(c<{ Status?: string }>(new GetBucketVersioningCommand({ Bucket: bucket })), (data) => ({
          enabled: data.Status === 'Enabled',
          suspended: data.Status === 'Suspended',
        }))
      : UNREAD,
    security
      ? dim(
          c<{
            ServerSideEncryptionConfiguration?: {
              Rules?: {
                ApplyServerSideEncryptionByDefault?: {
                  SSEAlgorithm?: string
                  KMSMasterKeyID?: string
                }
              }[]
            }
          }>(new GetBucketEncryptionCommand({ Bucket: bucket })),
          (data) => {
            const rules = data.ServerSideEncryptionConfiguration?.Rules ?? []
            if (!rules.length) return null
            return {
              algorithm: rules[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null,
              keyArn: rules[0]?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID ?? null,
            }
          },
        )
      : UNREAD,
    lifecycleWanted
      ? dim(
          c<{
            Rules?: {
              Status?: string
              AbortIncompleteMultipartUpload?: unknown
              Expiration?: unknown
              Transitions?: unknown[]
              NoncurrentVersionExpiration?: unknown
            }[]
          }>(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })),
          (data) => {
            const rules = (data.Rules ?? []).filter((rule) => rule.Status !== 'Disabled')
            if (!rules.length) return null
            return {
              rules: rules.length,
              abortMpu: rules.some((rule) => Boolean(rule.AbortIncompleteMultipartUpload)),
              expiration: rules.some((rule) => Boolean(rule.Expiration)),
              transition: rules.some((rule) => Boolean(rule.Transitions?.length)),
              noncurrentExpiration: rules.some((rule) => Boolean(rule.NoncurrentVersionExpiration)),
            }
          },
        )
      : UNREAD,
    lifecycleWanted
      ? dim(
          c<{ ReplicationConfiguration?: { Rules?: unknown[] } }>(
            new GetBucketReplicationCommand({ Bucket: bucket }),
          ),
          (data) => {
            const rules = data.ReplicationConfiguration?.Rules?.length ?? 0
            return rules ? { rules } : null
          },
        )
      : UNREAD,
    security
      ? read(() =>
          send<{ Policy?: string }>(client, new GetBucketPolicyCommand({ Bucket: bucket })),
        )
      : Promise.resolve({ status: 'unread' as ReadStatus, data: null }),
    security
      ? dim(
          c<{ PolicyStatus?: { IsPublic?: boolean } }>(
            new GetBucketPolicyStatusCommand({ Bucket: bucket }),
          ),
          (data) => ({ isPublic: Boolean(data.PolicyStatus?.IsPublic) }),
        )
      : UNREAD,
    security
      ? dim(
          c<{
            PublicAccessBlockConfiguration?: {
              BlockPublicAcls?: boolean
              IgnorePublicAcls?: boolean
              BlockPublicPolicy?: boolean
              RestrictPublicBuckets?: boolean
            }
          }>(new GetPublicAccessBlockCommand({ Bucket: bucket })),
          (data) => {
            const cfg = data.PublicAccessBlockConfiguration
            if (!cfg) return null
            return {
              blockPublicAcls: Boolean(cfg.BlockPublicAcls),
              ignorePublicAcls: Boolean(cfg.IgnorePublicAcls),
              blockPublicPolicy: Boolean(cfg.BlockPublicPolicy),
              restrictPublicBuckets: Boolean(cfg.RestrictPublicBuckets),
            }
          },
        )
      : UNREAD,
    security
      ? dim(
          c<{ OwnershipControls?: { Rules?: { ObjectOwnership?: string }[] } }>(
            new GetBucketOwnershipControlsCommand({ Bucket: bucket }),
          ),
          (data) => {
            const mode = data.OwnershipControls?.Rules?.[0]?.ObjectOwnership ?? null
            return mode ? { mode } : null
          },
        )
      : UNREAD,
    security
      ? dim(
          c<{ CORSRules?: { AllowedOrigins?: string[] }[] }>(
            new GetBucketCorsCommand({ Bucket: bucket }),
          ),
          (data) => {
            const rules = data.CORSRules ?? []
            if (!rules.length) return null
            return {
              rules: rules.length,
              allOrigins: rules.some((rule) => (rule.AllowedOrigins ?? []).includes('*')),
            }
          },
        )
      : UNREAD,
    security || observability
      ? dim(
          c<{ LoggingEnabled?: unknown }>(new GetBucketLoggingCommand({ Bucket: bucket })),
          (data) => ({
            enabled: Boolean(data.LoggingEnabled),
          }),
        )
      : UNREAD,
    observability
      ? dim(c<{ TagSet?: unknown[] }>(new GetBucketTaggingCommand({ Bucket: bucket })), (data) =>
          data.TagSet?.length ? { count: data.TagSet.length } : null,
        )
      : UNREAD,
    observability
      ? dim(
          c<{
            TopicConfigurations?: unknown[]
            QueueConfigurations?: unknown[]
            LambdaFunctionConfigurations?: unknown[]
            EventBridgeConfiguration?: unknown
          }>(new GetBucketNotificationConfigurationCommand({ Bucket: bucket })),
          (data) => {
            const targets =
              (data.TopicConfigurations?.length ?? 0) +
              (data.QueueConfigurations?.length ?? 0) +
              (data.LambdaFunctionConfigurations?.length ?? 0) +
              (data.EventBridgeConfiguration ? 1 : 0)
            return targets ? { targets } : null
          },
        )
      : UNREAD,
    observability
      ? dim(
          c<{ InventoryConfigurationList?: unknown[] }>(
            new ListBucketInventoryConfigurationsCommand({ Bucket: bucket }),
          ),
          (data) =>
            data.InventoryConfigurationList?.length
              ? { count: data.InventoryConfigurationList.length }
              : null,
        )
      : UNREAD,
  ])

  const policy: Dim<PolicyFacts> =
    policyRead.status === 'available'
      ? policyRead.data?.Policy
        ? { status: 'available', value: evaluatePolicy(policyRead.data.Policy) }
        : { status: 'not_configured', value: null }
      : { status: policyRead.status, value: null }

  let acl: BucketFacts['acl'] = UNREAD
  if (security) {
    if (ownership.value?.mode === 'BucketOwnerEnforced') {
      acl = { status: 'skipped_acls_disabled', value: null }
    } else {
      acl = await dim(
        c<{ Grants?: { Grantee?: { URI?: string }; Permission?: string }[] }>(
          new GetBucketAclCommand({ Bucket: bucket }),
        ),
        (data) => {
          const grants = data.Grants ?? []
          const open = grants.filter(
            (grant) => grant.Grantee?.URI === ALL_USERS || grant.Grantee?.URI === AUTH_USERS,
          )
          return {
            allUsers: open.some((grant) => grant.Grantee?.URI === ALL_USERS),
            authenticatedUsers: open.some((grant) => grant.Grantee?.URI === AUTH_USERS),
            write: open.some(
              (grant) => grant.Permission === 'WRITE' || grant.Permission === 'FULL_CONTROL',
            ),
          }
        },
      )
      // An ACL with no grants beyond the owner is a configured, private ACL.
      if (acl.status === 'not_configured')
        acl = {
          status: 'available',
          value: { allUsers: false, authenticatedUsers: false, write: false },
        }
    }
  }

  const facts: BucketFacts = {
    bucket,
    region,
    aws: options.aws ?? false,
    head,
    versioning,
    encryption,
    lifecycle,
    replication,
    policy,
    policyStatus,
    pab,
    ownership,
    acl,
    cors,
    logging,
    tagging,
    notifications,
    inventory,
    account: options.account ?? { pab: { status: 'unread', value: null } },
    capacity: options.capacity ?? null,
    exposure: { verdict: null, reasons: [] },
  }
  facts.exposure = security ? exposureOf(facts) : { verdict: null, reasons: ['not_read'] }
  return facts
}

/**
 * Public exposure from policy, ACL and the bucket's public access block. The
 * account-level block is a separate API this reader does not call; a bucket
 * proved public here may still be blocked there, and the reasons say so.
 */
export function exposureOf(facts: BucketFacts): Exposure {
  const reasons: ExposureReason[] = []
  let policyPublic: boolean | null = null
  if (facts.policyStatus.status === 'available') {
    policyPublic = Boolean(facts.policyStatus.value?.isPublic)
    if (policyPublic) reasons.push('status_public')
  } else if (facts.policy.status === 'not_configured') {
    policyPublic = false
  } else if (facts.policy.status === 'available' && facts.policy.value) {
    if (facts.policy.value.unreadable) policyPublic = null
    else {
      policyPublic = policyIsPublic(facts.policy.value)
      if (facts.policy.value.publicWrite) reasons.push('policy_write')
      if (facts.policy.value.publicRead) reasons.push('policy_read')
      if (facts.policy.value.publicList) reasons.push('policy_list')
    }
  }
  if (policyPublic === null) reasons.push('policy_unknown')

  let aclPublic: boolean | null = null
  if (facts.acl.status === 'skipped_acls_disabled') aclPublic = false
  else if (facts.acl.status === 'available' && facts.acl.value) {
    aclPublic = facts.acl.value.allUsers || facts.acl.value.authenticatedUsers
    if (facts.acl.value.allUsers) reasons.push('acl_everyone')
    else if (facts.acl.value.authenticatedUsers) reasons.push('acl_authenticated')
  } else reasons.push('acl_unknown')

  const pab = facts.pab.value
  if (pab?.restrictPublicBuckets && policyPublic) {
    policyPublic = false
    reasons.push('restrict_blocks')
  }
  if (pab?.ignorePublicAcls && aclPublic) {
    aclPublic = false
    reasons.push('ignore_blocks')
  }
  const account = facts.account.pab.value
  if (account?.restrictPublicBuckets && policyPublic) {
    policyPublic = false
    reasons.push('account_restrict_blocks')
  }
  if (account?.ignorePublicAcls && aclPublic) {
    aclPublic = false
    reasons.push('account_ignore_blocks')
  }

  let verdict: boolean | null = null
  if (policyPublic === true || aclPublic === true) verdict = true
  else if (policyPublic === false && aclPublic === false) verdict = false
  // On AWS an unread account block could still cancel this; elsewhere there is none.
  const accountKnown =
    facts.account.pab.status === 'available' || facts.account.pab.status === 'not_configured'
  if (verdict === true && facts.aws && !accountKnown) reasons.push('account_block_unread')
  return { verdict, reasons }
}

/** The facts worth remembering: statuses and booleans only, never a document. */
export function rememberable(facts: BucketFacts): Record<string, unknown> {
  return {
    region: facts.region,
    head_status: facts.head,
    publicly_exposed: facts.exposure.verdict,
    versioning_status: facts.versioning.status,
    versioning_enabled: facts.versioning.value?.enabled ?? false,
    encryption_status: facts.encryption.status,
    lifecycle_status: facts.lifecycle.status,
    lifecycle_abort_mpu: facts.lifecycle.value?.abortMpu ?? false,
    lifecycle_noncurrent: facts.lifecycle.value?.noncurrentExpiration ?? false,
    public_access_block_status:
      facts.pab.status === 'available' && facts.pab.value
        ? Object.values(facts.pab.value).every(Boolean)
          ? 'available'
          : 'partial'
        : facts.pab.status,
    policy_status: facts.policy.status,
    acl_status: facts.acl.status,
    cors_status: facts.cors.status,
    logging_status: facts.logging.status,
    object_ownership: facts.ownership.value?.mode ?? null,
    ...(facts.capacity
      ? {
          size_bytes: facts.capacity.bytes,
          objects: facts.capacity.objects,
          monthly_usd: facts.capacity.monthlyUsd,
          growth_bytes: facts.capacity.growthBytes,
          capacity_at: facts.capacity.at,
        }
      : {}),
  }
}

/** Dimensions whose read was blind, by product name. */
export function blindSpots(facts: BucketFacts): { item: string; status: ReadStatus }[] {
  const items: [string, ReadStatus][] = [
    ['versioning', facts.versioning.status],
    ['encryption', facts.encryption.status],
    ['lifecycle', facts.lifecycle.status],
    ['bucket policy', facts.policy.status],
    ['policy status', facts.policyStatus.status],
    ['public access block', facts.pab.status],
    ['object ownership', facts.ownership.status],
    ['ACL', facts.acl.status],
    ['CORS', facts.cors.status],
    ['logging', facts.logging.status],
    ['tagging', facts.tagging.status],
    ['notifications', facts.notifications.status],
    ['inventory', facts.inventory.status],
  ]
  return items
    .filter(
      ([, status]) =>
        status === 'access_denied' ||
        status === 'error' ||
        status === 'provider_unsupported' ||
        status === 'region_mismatch',
    )
    .map(([item, status]) => ({ item, status }))
}
