import type { ProviderConfig } from '../providers'
import {
  type Raw,
  readAccountBlock,
  readAnalyzer,
  readEvents,
  readIam,
  readKeyPolicy,
  readMetrics,
  readScps,
} from '../s3/raw'
import { agentTool, assertInScope, providerParam, type ToolDeps, Type } from './policy'

export const ACCOUNT_READS = [
  'public_access_block',
  'iam',
  'scps',
  'kms_key_policy',
  'access_analyzer',
  'storage_metrics',
  'cloudtrail',
] as const
export type AccountRead = (typeof ACCOUNT_READS)[number]

/** One account-level read on AWS, as the API returns it. The tool and `query` share it. */
export async function readAccountLevel(
  deps: ToolDeps,
  config: ProviderConfig,
  input: {
    read: AccountRead
    bucket?: string
    key?: string
    days?: number
    token?: string
    region?: string
    signal?: AbortSignal
  },
): Promise<Raw> {
  if (!ACCOUNT_READS.includes(input.read))
    throw new Error(`read must be one of ${ACCOUNT_READS.join(', ')}.`)
  if (!deps.providers.isAws(config))
    return { status: 'provider_unsupported', error: 'Account-level reads exist on AWS only.' }
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new Error(`${input.read} needs ${what}.`)
    return value
  }
  // Metrics, events and keys live in a region: the one named, a key ARN's own, or the account's.
  const region =
    input.region ||
    /^arn:aws[\w-]*:kms:([\w-]+):/.exec(input.key ?? '')?.[1] ||
    config.region ||
    'us-east-1'
  const p = deps.providers
  switch (input.read) {
    case 'public_access_block':
      return readAccountBlock(p.sts(config), p.control(config), input.signal)
    case 'iam':
      return readIam(p.iam(config), input.token, input.signal)
    case 'scps':
      return readScps(p.sts(config), p.organizations(config), input.signal)
    case 'kms_key_policy':
      return readKeyPolicy(p.kms(config, region), need(input.key, 'key'), input.signal)
    case 'access_analyzer':
      return readAnalyzer(p.accessAnalyzer(config, region), input.bucket, input.signal)
    case 'storage_metrics':
      return readMetrics(
        p.cloudwatch(config, region),
        need(input.bucket, 'bucket'),
        input.days ?? 14,
        input.signal,
      )
    case 'cloudtrail':
      return readEvents(
        p.cloudTrail(config, region),
        need(input.bucket, 'bucket'),
        input.days ?? 90,
        input.token,
        input.signal,
      )
  }
}

/** Account-level reads on AWS, as the APIs return them. */
export function accountTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'account',
    description:
      'Read account-level data on AWS, as the API returns it: public_access_block (the account-wide S3 block), iam (one page of GetAccountAuthorizationDetails: users, groups, roles and their policies; pass the returned Marker as `token` for the next page), scps (the service control policies that apply through the OU chain), kms_key_policy (a key, by `key`), access_analyzer (IAM Access Analyzer findings, for `bucket` when given), storage_metrics (CloudWatch daily BucketSizeBytes by storage type and NumberOfObjects for `bucket` over `days`), cloudtrail (one page of management events naming `bucket` over `days`; `token` for the next). The result is { status, value } or { status, error }. Account ids appear as <account>.',
    parameters: Type.Object({
      provider_id: providerParam,
      read: Type.Union(ACCOUNT_READS.map((name) => Type.Literal(name))),
      bucket: Type.Optional(Type.String()),
      key: Type.Optional(Type.String({ description: 'KMS key id or ARN for kms_key_policy.' })),
      days: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: 'Window for storage_metrics and cloudtrail (default 14 and 90).',
        }),
      ),
      token: Type.Optional(
        Type.String({ description: 'The next-page token a previous read returned.' }),
      ),
      region: Type.Optional(
        Type.String({
          description:
            "Region for storage_metrics, cloudtrail, access_analyzer and kms_key_policy; default the account's (a key ARN's own for a key).",
        }),
      ),
    }),
    timeoutMs: 120_000,
    target: (args) => (args.bucket ? `${args.read} · ${args.bucket}` : args.read),
    run: async (args, run) => {
      const { config } = await run.provider(args.provider_id)
      if (args.bucket) assertInScope(config, args.bucket)
      const result = await readAccountLevel(deps, config, {
        read: args.read as AccountRead,
        bucket: args.bucket,
        key: args.key,
        days: args.days,
        token: args.token,
        region: args.region,
        signal: run.signal,
      })
      return {
        model: JSON.stringify(result, null, 1),
        note: result.status.replace(/_/g, ' '),
        view: { kind: 'raw' as const, title: args.read, value: result },
      }
    },
  })
}
