/**
 * What a reading changed, and who changed it.
 *
 * The comparison is local and deterministic: last remembered posture against
 * the reading just taken. CloudTrail is consulted only after a difference is
 * found, only for management events, and a denied lookup is reported as
 * unavailable — never as "no one changed it".
 */
import { type CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail'
import type { PostureChange } from '@shared/contract'
import { classify } from './status'

const FIELDS: { key: string; label: string }[] = [
  { key: 'publicly_exposed', label: 'public exposure' },
  { key: 'encryption_status', label: 'encryption' },
  { key: 'public_access_block_status', label: 'public access block' },
  { key: 'policy_status', label: 'bucket policy' },
  { key: 'acl_status', label: 'ACL' },
  { key: 'cors_status', label: 'CORS' },
  { key: 'logging_status', label: 'access logging' },
  { key: 'versioning_status', label: 'versioning' },
  { key: 'lifecycle_status', label: 'lifecycle' },
  { key: 'object_ownership', label: 'object ownership' },
]

function show(value: unknown): string {
  if (value === true) return 'on'
  if (value === false) return 'off'
  if (value === undefined || value === null || value === '') return 'not read'
  return String(value).slice(0, 40)
}

export function diffPosture(
  bucket: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  at: string,
): PostureChange[] {
  if (!before) return []
  const changes: PostureChange[] = []
  for (const field of FIELDS) {
    if (!(field.key in before) || !(field.key in after)) continue
    const old = before[field.key]
    const next = after[field.key]
    if (JSON.stringify(old) === JSON.stringify(next)) continue
    changes.push({ bucket, field: field.label, before: show(old), after: show(next), at })
  }
  return changes
}

const MUTATIONS = [
  'PutBucketPolicy',
  'DeleteBucketPolicy',
  'PutBucketAcl',
  'PutBucketPublicAccessBlock',
  'DeleteBucketPublicAccessBlock',
  'PutBucketEncryption',
  'DeleteBucketEncryption',
  'PutBucketVersioning',
  'PutBucketLifecycle',
  'PutBucketLifecycleConfiguration',
  'PutBucketLogging',
  'PutBucketCors',
  'PutBucketOwnershipControls',
  'PutBucketReplication',
]

export interface Attribution {
  at: string
  event: string
  actor: string
}

export const CLOUDTRAIL_DAYS = 90
const MAX_EVENT_PAGES = 20

export interface AttributionResult {
  events: Attribution[]
  status: 'ok' | 'denied' | 'unsupported' | 'error'
  from: string
  to: string
  days: number
  truncated: boolean
}

export async function attribute(
  client: CloudTrailClient,
  bucket: string,
  signal?: AbortSignal,
): Promise<AttributionResult> {
  const to = new Date()
  const from = new Date(to.getTime() - CLOUDTRAIL_DAYS * 86_400_000)
  try {
    const found: Attribution[] = []
    let nextToken: string | undefined
    let truncated = false
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const response = await client.send(
        new LookupEventsCommand({
          LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: bucket }],
          StartTime: from,
          EndTime: to,
          MaxResults: 50,
          NextToken: nextToken,
        }),
        { abortSignal: signal },
      )
      for (const event of response.Events ?? []) {
        if (!MUTATIONS.includes(event.EventName ?? '')) continue
        found.push({
          at: event.EventTime ? new Date(event.EventTime).toISOString() : '',
          event: event.EventName ?? 'change',
          actor:
            event.Username ??
            (event.CloudTrailEvent
              ? (() => {
                  try {
                    const parsed = JSON.parse(event.CloudTrailEvent) as {
                      userIdentity?: { arn?: string; userName?: string }
                    }
                    return parsed.userIdentity?.arn ?? parsed.userIdentity?.userName ?? 'unknown'
                  } catch {
                    return 'unknown'
                  }
                })()
              : 'unknown'),
        })
      }
      nextToken = response.NextToken
      if (!nextToken) break
      if (page === MAX_EVENT_PAGES - 1) truncated = true
    }
    found.sort((a, b) => b.at.localeCompare(a.at))
    return {
      events: found.slice(0, 20),
      status: 'ok',
      from: from.toISOString(),
      to: to.toISOString(),
      days: CLOUDTRAIL_DAYS,
      truncated: truncated || found.length > 20,
    }
  } catch (error) {
    return {
      events: [],
      status:
        classify(error) === 'provider_unsupported'
          ? 'unsupported'
          : classify(error) === 'access_denied'
            ? 'denied'
            : 'error',
      from: from.toISOString(),
      to: to.toISOString(),
      days: CLOUDTRAIL_DAYS,
      truncated: false,
    }
  }
}
