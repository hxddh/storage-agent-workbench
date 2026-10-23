import {
  GetBucketAclCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketLoggingCommand,
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
import { classify, dimensionStatus, httpStatus, type Read, type ReadStatus, read } from './status'

export interface Posture {
  bucket: string
  region: string
  head_bucket_status: ReadStatus
  access_status: ReadStatus
  versioning_status: ReadStatus
  versioning_enabled: boolean
  encryption_status: ReadStatus
  lifecycle_status: ReadStatus
  logging_status: ReadStatus
  logging_enabled: boolean
  replication_status: ReadStatus
  policy_status: ReadStatus
  public_access_block_status: ReadStatus
  policy_public_status: ReadStatus
  policy_is_public: boolean | null
  ownership_status: ReadStatus
  object_ownership: string | null
  acls_disabled: boolean | null
  acl_status: ReadStatus
  acl_public: boolean | null
  publicly_exposed: boolean | null
  tagging_status: ReadStatus
  inventory_status: ReadStatus
  provider_unsupported_items: string[]
  access_denied_items: string[]
  error_items: string[]
}

const ALL_USERS = 'http://acs.amazonaws.com/groups/global/AllUsers'
const AUTH_USERS = 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers'

export async function snapshot(
  client: S3Client,
  providerRegion: string,
  bucket: string,
): Promise<Posture> {
  let headStatus: ReadStatus = 'available'
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (error) {
    const http = httpStatus(error)
    const status = classify(error)
    if (status === 'access_denied') headStatus = 'access_denied'
    else if (status === 'provider_unsupported') headStatus = 'provider_unsupported'
    else if (http === 301 || (error as { name?: string })?.name === 'PermanentRedirect') {
      headStatus = 'region_mismatch'
    } else headStatus = 'error'
  }

  const [
    location,
    versioning,
    encryption,
    lifecycle,
    logging,
    replication,
    policy,
    pab,
    tagging,
    inventory,
    policyStatus,
    ownership,
  ] = await Promise.all([
    read(() => client.send(new GetBucketLocationCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketVersioningCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketEncryptionCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketLoggingCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketReplicationCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketPolicyCommand({ Bucket: bucket }))),
    read(() => client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketTaggingCommand({ Bucket: bucket }))),
    read(() => client.send(new ListBucketInventoryConfigurationsCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketPolicyStatusCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket }))),
  ])

  const ownershipRules = ownership.data?.OwnershipControls?.Rules ?? []
  const objectOwnership =
    ownership.status === 'available' ? (ownershipRules[0]?.ObjectOwnership ?? null) : null
  const aclsDisabled = objectOwnership === 'BucketOwnerEnforced'
  const acl: Read<{ Grants?: { Grantee?: { URI?: string } }[] }> = aclsDisabled
    ? { status: 'skipped_acls_disabled', data: null }
    : await read(() => client.send(new GetBucketAclCommand({ Bucket: bucket })))

  const versioningEnabled =
    versioning.status === 'available' && versioning.data?.Status === 'Enabled'
  const encryptionConfigured =
    encryption.status === 'available' &&
    (encryption.data?.ServerSideEncryptionConfiguration?.Rules?.length ?? 0) > 0
  const lifecycleConfigured =
    lifecycle.status === 'available' && (lifecycle.data?.Rules?.length ?? 0) > 0
  const loggingEnabled = logging.status === 'available' && Boolean(logging.data?.LoggingEnabled)
  const replicationConfigured =
    replication.status === 'available' &&
    (replication.data?.ReplicationConfiguration?.Rules?.length ?? 0) > 0
  const policyConfigured = policy.status === 'available'
  const pabConfigured = pab.status === 'available'
  const taggingConfigured =
    tagging.status === 'available' && (tagging.data?.TagSet?.length ?? 0) > 0
  const inventoryConfigured =
    inventory.status === 'available' &&
    (inventory.data?.InventoryConfigurationList?.length ?? 0) > 0

  let policyIsPublic: boolean | null = null
  if (policyStatus.status === 'available')
    policyIsPublic = Boolean(policyStatus.data?.PolicyStatus?.IsPublic)
  else if (policyStatus.status === 'not_configured') policyIsPublic = false

  let aclPublic: boolean | null = null
  if (acl.status === 'skipped_acls_disabled') aclPublic = false
  else if (acl.status === 'available') {
    aclPublic = (acl.data?.Grants ?? []).some(
      (grant) => grant.Grantee?.URI === ALL_USERS || grant.Grantee?.URI === AUTH_USERS,
    )
  } else if (acl.status === 'not_configured') aclPublic = false

  let exposed: boolean | null = null
  if (policyIsPublic === true || aclPublic === true) exposed = true
  else if (policyIsPublic === false && aclPublic === false) exposed = false

  const region =
    location.status === 'available'
      ? (location.data?.LocationConstraint ?? providerRegion ?? 'us-east-1')
      : providerRegion

  const dims: [string, ReadStatus][] = [
    ['location', location.status],
    ['versioning', versioning.status],
    ['encryption', encryption.status],
    ['lifecycle', lifecycle.status],
    ['logging', logging.status],
    ['replication', replication.status],
    ['policy', policy.status],
    ['public_access_block', pab.status],
    ['tagging', tagging.status],
    ['inventory', inventory.status],
    ['policy_public', policyStatus.status],
    ['ownership', ownership.status],
  ]

  return {
    bucket,
    region,
    head_bucket_status: headStatus,
    access_status:
      headStatus === 'access_denied' || headStatus === 'error' ? headStatus : 'available',
    versioning_status: dimensionStatus(versioning, versioningEnabled),
    versioning_enabled: versioningEnabled,
    encryption_status: dimensionStatus(encryption, encryptionConfigured),
    lifecycle_status: dimensionStatus(lifecycle, lifecycleConfigured),
    logging_status: dimensionStatus(logging, loggingEnabled),
    logging_enabled: loggingEnabled,
    replication_status: dimensionStatus(replication, replicationConfigured),
    policy_status: dimensionStatus(policy, policyConfigured),
    public_access_block_status: dimensionStatus(pab, pabConfigured),
    policy_public_status: policyStatus.status,
    policy_is_public: policyIsPublic,
    ownership_status: ownership.status,
    object_ownership: objectOwnership,
    acls_disabled: objectOwnership ? aclsDisabled : null,
    acl_status: acl.status,
    acl_public: aclPublic,
    publicly_exposed: exposed,
    tagging_status: dimensionStatus(tagging, taggingConfigured),
    inventory_status: dimensionStatus(inventory, inventoryConfigured),
    provider_unsupported_items: dims
      .filter(([, s]) => s === 'provider_unsupported')
      .map(([n]) => n),
    access_denied_items: dims.filter(([, s]) => s === 'access_denied').map(([n]) => n),
    error_items: dims.filter(([, s]) => s === 'error').map(([n]) => n),
  }
}

/** The posture fields worth remembering; booleans and status enums only. */
export function postureProjection(p: Posture): Record<string, unknown> {
  const keys = [
    'head_bucket_status',
    'access_status',
    'versioning_status',
    'versioning_enabled',
    'encryption_status',
    'lifecycle_status',
    'logging_status',
    'logging_enabled',
    'replication_status',
    'policy_status',
    'public_access_block_status',
    'policy_public_status',
    'policy_is_public',
    'object_ownership',
    'acls_disabled',
    'acl_public',
    'publicly_exposed',
    'tagging_status',
    'inventory_status',
  ] as const
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = p[key]
  return out
}
