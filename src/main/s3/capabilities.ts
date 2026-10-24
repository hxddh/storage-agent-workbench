/**
 * What an S3-compatible provider actually implements. The app still tries a
 * read; this table turns a 501 into a precise sentence and keeps Settings
 * honest about what a provider can answer.
 */
export type ProviderKind = 'aws' | 'r2' | 'minio' | 'aliyun' | 'gcs' | 'other'

export interface ProviderCapabilities {
  kind: ProviderKind
  label: string
  /** Account-wide block, CloudWatch capacity, CloudTrail, IAM, KMS, Access Analyzer. */
  accountBlock: boolean
  capacity: boolean
  cloudTrail: boolean
  iam: boolean
  kms: boolean
  accessAnalyzer: boolean
  /** Configuration APIs that are commonly absent outside AWS. */
  policyStatus: boolean
  ownership: boolean
  acl: 'supported' | 'none' | 'unknown'
  logging: boolean
  inventory: boolean
}

const TABLE: Record<ProviderKind, ProviderCapabilities> = {
  aws: {
    kind: 'aws',
    label: 'AWS S3',
    accountBlock: true,
    capacity: true,
    cloudTrail: true,
    iam: true,
    kms: true,
    accessAnalyzer: true,
    policyStatus: true,
    ownership: true,
    acl: 'supported',
    logging: true,
    inventory: true,
  },
  r2: {
    kind: 'r2',
    label: 'Cloudflare R2',
    accountBlock: false,
    capacity: false,
    cloudTrail: false,
    iam: false,
    kms: false,
    accessAnalyzer: false,
    policyStatus: false,
    ownership: false,
    acl: 'none',
    logging: false,
    inventory: false,
  },
  minio: {
    kind: 'minio',
    label: 'MinIO',
    accountBlock: false,
    capacity: false,
    cloudTrail: false,
    iam: false,
    kms: false,
    accessAnalyzer: false,
    policyStatus: false,
    ownership: false,
    acl: 'unknown',
    logging: false,
    inventory: false,
  },
  aliyun: {
    kind: 'aliyun',
    label: 'Aliyun OSS',
    accountBlock: false,
    capacity: false,
    cloudTrail: false,
    iam: false,
    kms: false,
    accessAnalyzer: false,
    policyStatus: false,
    ownership: false,
    acl: 'supported',
    logging: true,
    inventory: false,
  },
  gcs: {
    kind: 'gcs',
    label: 'GCS interop',
    accountBlock: false,
    capacity: false,
    cloudTrail: false,
    iam: false,
    kms: false,
    accessAnalyzer: false,
    policyStatus: false,
    ownership: false,
    acl: 'unknown',
    logging: false,
    inventory: false,
  },
  other: {
    kind: 'other',
    label: 'S3-compatible',
    accountBlock: false,
    capacity: false,
    cloudTrail: false,
    iam: false,
    kms: false,
    accessAnalyzer: false,
    policyStatus: false,
    ownership: false,
    acl: 'unknown',
    logging: false,
    inventory: false,
  },
}

export function detectProviderKind(endpoint: string): ProviderKind {
  const url = endpoint.toLowerCase()
  if (!url) return 'aws'
  if (url.includes('r2.cloudflarestorage.com')) return 'r2'
  if (url.includes('aliyuncs.com')) return 'aliyun'
  if (url.includes('storage.googleapis.com')) return 'gcs'
  if (url.includes('minio') || url.includes('localhost') || url.includes('127.0.0.1'))
    return 'minio'
  return 'other'
}

export function capabilitiesOf(kind: string | null | undefined): ProviderCapabilities {
  return TABLE[kind as ProviderKind] ?? TABLE.other
}
