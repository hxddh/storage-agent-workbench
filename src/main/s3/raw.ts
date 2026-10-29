/**
 * Raw read-only reads, returned as the APIs return them.
 *
 * Nothing here decides anything: no verdict, no "public", no rule, no summary.
 * Each read comes back as `{ status, value }` (or `{ status, error }`), with the
 * response's own fields. The one change made to a value is that 12-digit
 * account ids become `<account>`: the account id is never stored, shown or
 * sent to the model.
 */
import {
  type AccessAnalyzerClient,
  ListAnalyzersCommand,
  ListFindingsCommand,
} from '@aws-sdk/client-accessanalyzer'
import { type CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail'
import { type CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { GetAccountAuthorizationDetailsCommand, type IAMClient } from '@aws-sdk/client-iam'
import { DescribeKeyCommand, GetKeyPolicyCommand, type KMSClient } from '@aws-sdk/client-kms'
import {
  DescribePolicyCommand,
  ListParentsCommand,
  ListPoliciesForTargetCommand,
  type OrganizationsClient,
} from '@aws-sdk/client-organizations'
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
  GetBucketWebsiteCommand,
  GetObjectLockConfigurationCommand,
  GetPublicAccessBlockCommand,
  ListBucketInventoryConfigurationsCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import {
  GetPublicAccessBlockCommand as GetAccountBlockCommand,
  type S3ControlClient,
} from '@aws-sdk/client-s3-control'
import { GetCallerIdentityCommand, type STSClient } from '@aws-sdk/client-sts'
import { classify, errorCode, isAbort, type ReadStatus } from './status'

export interface Raw {
  status: ReadStatus
  value?: unknown
  /** The provider's error code and message when the read did not succeed. */
  error?: string
}

/** Every 12-digit number in a value becomes `<account>`, keys included. */
export function scrub(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\b\d{12}\b/g, '<account>')
  if (Array.isArray(value)) return value.map(scrub)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== '$metadata')
        .map(([key, item]) => [scrub(key) as string, scrub(item)]),
    )
  return value
}

async function attempt(
  call: () => Promise<unknown>,
  shape: (data: never) => unknown = (data) => data,
): Promise<Raw> {
  try {
    return { status: 'available', value: scrub(shape((await call()) as never)) }
  } catch (error) {
    if (isAbort(error)) throw error
    const status = classify(error)
    const message = error instanceof Error ? error.message : String(error)
    return status === 'not_configured'
      ? { status }
      : { status, error: scrub(`${errorCode(error)}: ${message}`) as string }
  }
}

/** A JSON document field, parsed when it is JSON. */
function json(text: unknown): unknown {
  if (typeof text !== 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const SECTIONS = [
  'location',
  'policy',
  'policy_status',
  'public_access_block',
  'acl',
  'ownership',
  'encryption',
  'versioning',
  'object_lock',
  'lifecycle',
  'replication',
  'cors',
  'website',
  'logging',
  'notification',
  'inventory',
  'tagging',
] as const
export type Section = (typeof SECTIONS)[number]

export interface ConfigOptions {
  signal?: AbortSignal
  /** A client for another region, when the bucket lives elsewhere. */
  regional?: (region: string) => S3Client
  defaultRegion: string
}

/** The bucket's configuration, section by section, as S3 returns it. */
export async function readConfig(
  base: S3Client,
  bucket: string,
  sections: readonly Section[],
  options: ConfigOptions,
): Promise<{ region: string | null; sections: Partial<Record<Section, Raw>> }> {
  const send = (client: S3Client, command: unknown) =>
    client.send(command as never, { abortSignal: options.signal })
  const location = await attempt(() => send(base, new GetBucketLocationCommand({ Bucket: bucket })))
  const constraint = (location.value as { LocationConstraint?: string } | undefined)
    ?.LocationConstraint
  const region = location.status === 'available' ? constraint || 'us-east-1' : null
  const client =
    region && options.regional && region !== options.defaultRegion ? options.regional(region) : base
  const Bucket = bucket
  const reads: Record<Exclude<Section, 'location'>, () => Promise<Raw>> = {
    policy: () =>
      attempt(
        () => send(client, new GetBucketPolicyCommand({ Bucket })),
        (data: { Policy?: string }) => json(data.Policy),
      ),
    policy_status: () => attempt(() => send(client, new GetBucketPolicyStatusCommand({ Bucket }))),
    public_access_block: () =>
      attempt(() => send(client, new GetPublicAccessBlockCommand({ Bucket }))),
    acl: () => attempt(() => send(client, new GetBucketAclCommand({ Bucket }))),
    ownership: () => attempt(() => send(client, new GetBucketOwnershipControlsCommand({ Bucket }))),
    encryption: () => attempt(() => send(client, new GetBucketEncryptionCommand({ Bucket }))),
    versioning: () => attempt(() => send(client, new GetBucketVersioningCommand({ Bucket }))),
    object_lock: () =>
      attempt(() => send(client, new GetObjectLockConfigurationCommand({ Bucket }))),
    lifecycle: () =>
      attempt(() => send(client, new GetBucketLifecycleConfigurationCommand({ Bucket }))),
    replication: () => attempt(() => send(client, new GetBucketReplicationCommand({ Bucket }))),
    cors: () => attempt(() => send(client, new GetBucketCorsCommand({ Bucket }))),
    website: () => attempt(() => send(client, new GetBucketWebsiteCommand({ Bucket }))),
    logging: () => attempt(() => send(client, new GetBucketLoggingCommand({ Bucket }))),
    notification: () =>
      attempt(() => send(client, new GetBucketNotificationConfigurationCommand({ Bucket }))),
    inventory: () =>
      attempt(() => send(client, new ListBucketInventoryConfigurationsCommand({ Bucket }))),
    tagging: () => attempt(() => send(client, new GetBucketTaggingCommand({ Bucket }))),
  }
  const out: Partial<Record<Section, Raw>> = {}
  if (sections.includes('location')) out.location = location
  await Promise.all(
    sections
      .filter((section): section is Exclude<Section, 'location'> => section !== 'location')
      .map(async (section) => {
        out[section] = await reads[section]()
      }),
  )
  return { region, sections: out }
}

/** The caller's account id, for the next read only; never returned. */
async function accountIdOf(sts: STSClient, signal?: AbortSignal): Promise<string> {
  const identity = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal })
  if (!identity.Account) throw new Error('STS returned no account.')
  return identity.Account
}

/** The account-wide S3 public access block. */
export function readAccountBlock(sts: STSClient, control: S3ControlClient, signal?: AbortSignal) {
  return attempt(async () =>
    control.send(new GetAccountBlockCommand({ AccountId: await accountIdOf(sts, signal) }), {
      abortSignal: signal,
    }),
  )
}

/** One page of IAM authorization details: users, groups, roles and policies. */
export function readIam(iam: IAMClient, marker?: string, signal?: AbortSignal) {
  return attempt(() =>
    iam.send(new GetAccountAuthorizationDetailsCommand({ Marker: marker, MaxItems: 100 }), {
      abortSignal: signal,
    }),
  )
}

/** The service control policies that apply to this account, through its OUs to the root. */
export function readScps(sts: STSClient, org: OrganizationsClient, signal?: AbortSignal) {
  return attempt(async () => {
    const options = { abortSignal: signal }
    const targets = [await accountIdOf(sts, signal)]
    for (let child = targets[0]!; ; ) {
      const parent = (await org.send(new ListParentsCommand({ ChildId: child }), options))
        .Parents?.[0]?.Id
      if (!parent || targets.includes(parent)) break
      targets.push(parent)
      child = parent
    }
    const ids = new Set<string>()
    for (const target of targets) {
      let token: string | undefined
      do {
        const page = await org.send(
          new ListPoliciesForTargetCommand({
            TargetId: target,
            Filter: 'SERVICE_CONTROL_POLICY',
            NextToken: token,
          }),
          options,
        )
        for (const policy of page.Policies ?? []) if (policy.Id) ids.add(policy.Id)
        token = page.NextToken
      } while (token)
    }
    const policies = []
    for (const id of ids) {
      const policy = (await org.send(new DescribePolicyCommand({ PolicyId: id }), options)).Policy
      policies.push({
        name: policy?.PolicySummary?.Name,
        id,
        document: json(policy?.Content),
      })
    }
    return { policies }
  })
}

/** A KMS key's metadata and its default key policy. */
export function readKeyPolicy(kms: KMSClient, keyId: string, signal?: AbortSignal) {
  return attempt(async () => {
    const options = { abortSignal: signal }
    const key = (await kms.send(new DescribeKeyCommand({ KeyId: keyId }), options)).KeyMetadata
    const policy = await kms.send(
      new GetKeyPolicyCommand({ KeyId: key?.Arn ?? keyId, PolicyName: 'default' }),
      options,
    )
    return { key, policy: json(policy.Policy) }
  })
}

/** IAM Access Analyzer findings, for one bucket when named; one page per analyzer. */
export function readAnalyzer(
  analyzer: AccessAnalyzerClient,
  bucket: string | undefined,
  signal?: AbortSignal,
) {
  return attempt(async () => {
    const options = { abortSignal: signal }
    const analyzers = (await analyzer.send(new ListAnalyzersCommand({}), options)).analyzers ?? []
    const out = []
    for (const item of analyzers) {
      if (!item.arn) continue
      const page = await analyzer.send(
        new ListFindingsCommand({
          analyzerArn: item.arn,
          maxResults: 100,
          ...(bucket ? { filter: { resource: { eq: [`arn:aws:s3:::${bucket}`] } } } : {}),
        }),
        options,
      )
      out.push({
        analyzer: item.name,
        type: item.type,
        findings: page.findings ?? [],
        next: page.nextToken ?? null,
      })
    }
    return { analyzers: out }
  })
}

const STORAGE_TYPES = [
  'StandardStorage',
  'IntelligentTieringFAStorage',
  'IntelligentTieringIAStorage',
  'IntelligentTieringAIAStorage',
  'IntelligentTieringAAStorage',
  'IntelligentTieringDAAStorage',
  'StandardIAStorage',
  'OneZoneIAStorage',
  'ReducedRedundancyStorage',
  'GlacierInstantRetrievalStorage',
  'GlacierStorage',
  'DeepArchiveStorage',
  'ExpressOneZone',
]

/** CloudWatch's daily S3 storage metrics for one bucket over `days`: size by storage type and object count. */
export function readMetrics(
  cloudwatch: CloudWatchClient,
  bucket: string,
  days: number,
  signal?: AbortSignal,
) {
  return attempt(async () => {
    const now = new Date()
    const queries = [
      ...STORAGE_TYPES.map((type, index) => ({ id: `s${index}`, metric: 'BucketSizeBytes', type })),
      { id: 'objects', metric: 'NumberOfObjects', type: 'AllStorageTypes' },
    ]
    const series: Record<string, { at: string; value: number }[]> = {}
    let token: string | undefined
    do {
      const response = await cloudwatch.send(
        new GetMetricDataCommand({
          StartTime: new Date(now.getTime() - days * 86_400_000),
          EndTime: now,
          NextToken: token,
          MetricDataQueries: queries.map((query) => ({
            Id: query.id,
            ReturnData: true,
            MetricStat: {
              Period: 86_400,
              Stat: 'Average',
              Metric: {
                Namespace: 'AWS/S3',
                MetricName: query.metric,
                Dimensions: [
                  { Name: 'BucketName', Value: bucket },
                  { Name: 'StorageType', Value: query.type },
                ],
              },
            },
          })),
        }),
        { abortSignal: signal },
      )
      for (const result of response.MetricDataResults ?? []) {
        const query = queries.find((item) => item.id === result.Id)
        if (!query) continue
        const name =
          query.metric === 'NumberOfObjects' ? 'NumberOfObjects' : `BucketSizeBytes:${query.type}`
        const points = (result.Timestamps ?? []).map((ts, i) => ({
          at: new Date(ts).toISOString(),
          value: result.Values?.[i] ?? 0,
        }))
        if (points.length)
          series[name] = [...(series[name] ?? []), ...points].sort((a, b) =>
            a.at.localeCompare(b.at),
          )
      }
      token = response.NextToken
    } while (token)
    return { bucket, days, series }
  })
}

/** One page of CloudTrail management events naming this bucket, newest first. */
export function readEvents(
  trail: CloudTrailClient,
  bucket: string,
  days: number,
  token?: string,
  signal?: AbortSignal,
) {
  return attempt(async () => {
    const to = new Date()
    const response = await trail.send(
      new LookupEventsCommand({
        LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: bucket }],
        StartTime: new Date(to.getTime() - days * 86_400_000),
        EndTime: to,
        MaxResults: 50,
        NextToken: token,
      }),
      { abortSignal: signal },
    )
    return {
      events: (response.Events ?? []).map((event) => ({
        ...event,
        CloudTrailEvent: json(event.CloudTrailEvent),
      })),
      next: response.NextToken ?? null,
    }
  })
}

export type { AccessAnalyzerClient, CloudTrailClient }
