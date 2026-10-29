import { ListBucketsCommand } from '@aws-sdk/client-s3'
import type { Observation, PostureChange, Table } from '@shared/contract'
import {
  ACCOUNT_SCOPE,
  BY_CODE,
  decide,
  decideAccount,
  ruleTitle,
  undecidedRules,
} from '../estate/rules'
import { type AccountFacts, readAccount, rememberAccount, UNREAD_ACCOUNT } from '../s3/account'
import { attribute, diffPosture } from '../s3/changes'
import { type BucketFacts, readBucket, rememberable } from '../s3/facts'
import { type Capacity, formatBytes, readCapacity } from '../s3/metrics'
import { permissionGaps } from '../s3/permissions'
import { isAbort } from '../s3/status'
import { agentTool, limitParam, providerParam, type ToolDeps, Type } from './policy'

const HARD_MAX_BUCKETS = 5000
const CONCURRENCY = 12
const TIMEOUT_MS = 300_000
/** Stop starting buckets this long before the tool's timeout, and report the rest as pending. */
const RESERVE_MS = 20_000
/** Issues a survey view carries; the true total travels beside them. */
const VIEW_ISSUES = 1000

function exposure(value: boolean | null): string {
  return value === true ? 'public' : value === false ? 'no' : 'unknown'
}

function dimension(status: string): string {
  return status === 'available'
    ? 'on'
    : status === 'not_configured'
      ? 'off'
      : status === 'partial'
        ? 'partial'
        : '?'
}

function accountState(
  facts: AccountFacts,
  aws: boolean,
): 'on' | 'partial' | 'off' | 'unknown' | 'n/a' {
  if (!aws) return 'n/a'
  if (facts.pab.status === 'not_configured') return 'off'
  if (facts.pab.status !== 'available' || !facts.pab.value) return 'unknown'
  const on = Object.values(facts.pab.value).filter(Boolean).length
  return on === 4 ? 'on' : on === 0 ? 'off' : 'partial'
}

export function surveyTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'survey',
    description:
      'Survey a storage account read-only: list its buckets; read each bucket’s exposure, encryption, public access blocks, TLS policy, ACLs, CORS, logging and lifecycle; read the account-wide public access block and, on AWS, each bucket’s size, object count, growth and monthly storage estimate; and let the rules open or resolve Issues. Buckets read longest ago come first; when it stops early, call it again to read the rest. Pass `buckets` to re-read only those (for example after the user applied a change).',
    parameters: Type.Object({
      provider_id: providerParam,
      buckets: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 50,
          description: 'Re-read only these buckets instead of the whole account.',
        }),
      ),
      limit: limitParam(HARD_MAX_BUCKETS),
    }),
    timeoutMs: TIMEOUT_MS,
    target: () => '',
    run: async (args, run) => {
      const started = Date.now()
      const { config, client } = await run.provider(args.provider_id)
      await run.setTarget(config.name)
      const aws = deps.providers.isAws(config)
      const inScope = (name: string) =>
        config.scope.buckets.length === 0 || config.scope.buckets.includes(name)

      const remembered = await deps.db.listBuckets(config.id)
      const previousPosture = new Map<string, Record<string, unknown>>()
      for (const row of remembered) {
        if (!row.posture_json) continue
        try {
          previousPosture.set(row.name, JSON.parse(row.posture_json) as Record<string, unknown>)
        } catch {
          // Ignore a damaged historical row; the next reading replaces it.
        }
      }
      const readAt = new Map(remembered.map((row) => [row.name, row.posture_at ?? '']))
      const regionOf = new Map<string, string>()
      for (const row of remembered) if (row.region) regionOf.set(row.name, row.region)

      let visible: string[]
      let complete = false
      if (args.buckets?.length) {
        visible = [...new Set(args.buckets)]
      } else {
        visible = []
        let token: string | undefined
        do {
          const response = await client.send(
            new ListBucketsCommand(token ? { ContinuationToken: token, MaxBuckets: 1000 } : {}),
            { abortSignal: run.signal },
          )
          for (const bucket of response.Buckets ?? []) {
            if (!bucket.Name) continue
            visible.push(bucket.Name)
            const region = (bucket as { BucketRegion?: string }).BucketRegion
            if (region) regionOf.set(bucket.Name, region)
          }
          token = response.ContinuationToken
        } while (token)
        complete = true
      }
      const scoped = visible.filter(inScope)
      const refused = visible.filter((name) => !inScope(name))
      // Never-read buckets first, then the oldest readings: repeated surveys cover a large account.
      const ordered = args.buckets?.length
        ? scoped
        : [...scoped].sort((a, b) => (readAt.get(a) ?? '').localeCompare(readAt.get(b) ?? ''))
      const limit = Math.max(1, Math.min(args.limit ?? HARD_MAX_BUCKETS, HARD_MAX_BUCKETS))
      const selected = ordered.slice(0, limit)

      // Account-wide reads happen once: the public access block and, by region, capacity.
      let account: AccountFacts = UNREAD_ACCOUNT
      const capacity = new Map<string, Capacity>()
      let capacityStatus: 'available' | 'access_denied' | 'error' | 'n/a' = 'n/a'
      const changed = { opened: 0, resolved: 0, recurred: 0 }
      const observations: Observation[] = []
      if (aws) {
        run.progress('Reading the account')
        account = await readAccount(
          deps.providers.sts(config),
          deps.providers.control(config),
          run.signal,
        )
        await deps.db.setAccountPosture(config.id, rememberAccount(account))
        const decision = decideAccount(account, aws, deps.lang())
        const applied = await run.assess.apply(
          config.id,
          ACCOUNT_SCOPE,
          decision.verdict === null ? {} : { account_public_access_block_missing: decision },
        )
        observations.push(...applied.observations)
        changed.opened += applied.delta.opened
        changed.resolved += applied.delta.resolved
        changed.recurred += applied.delta.recurred

        const byRegion = new Map<string, string[]>()
        for (const bucket of selected) {
          const region = regionOf.get(bucket) ?? config.region ?? 'us-east-1'
          byRegion.set(region, [...(byRegion.get(region) ?? []), bucket])
        }
        run.progress('Reading capacity')
        capacityStatus = 'available'
        for (const [region, buckets] of byRegion) {
          const result = await readCapacity(
            deps.providers.cloudwatch(config, region),
            buckets,
            run.signal,
          )
          for (const [bucket, value] of result.capacity) capacity.set(bucket, value)
          if (result.status !== 'available') capacityStatus = result.status
        }
      }
      run.progress(`0 of ${selected.length} buckets`)

      const read: BucketFacts[] = []
      const postureChanges: PostureChange[] = []
      const undecided = new Map<string, string[]>()
      const missing: string[] = []
      let next = 0
      let stopped = false

      // Each bucket is remembered the moment it is read: a stop or a timeout
      // keeps everything already seen.
      const worker = async () => {
        for (;;) {
          if (run.signal.aborted || Date.now() - started > TIMEOUT_MS - RESERVE_MS) {
            stopped = true
            return
          }
          const index = next++
          if (index >= selected.length) return
          const bucket = selected[index]!
          let facts: BucketFacts
          try {
            facts = await readBucket(client, bucket, {
              aspects: new Set(['security', 'lifecycle']),
              signal: run.signal,
              regional: run.regional,
              defaultRegion: config.region,
              aws,
              account,
              capacity: capacity.get(bucket) ?? null,
            })
          } catch (error) {
            if (isAbort(error)) {
              stopped = true
              return
            }
            throw error
          }
          if (facts.head === 'missing') {
            missing.push(bucket)
            continue
          }
          read.push(facts)
          const changeAt = new Date().toISOString()
          const changes = diffPosture(
            bucket,
            previousPosture.get(bucket) ?? null,
            rememberable(facts),
            changeAt,
          )
          if (changes.length) {
            postureChanges.push(...changes)
            await deps.db.insertChanges(config.id, bucket, changes)
          }
          await deps.db.upsertBucket(config.id, bucket, rememberable(facts), facts.region)
          const applied = await run.assess.apply(config.id, bucket, decide(facts, deps.lang()))
          observations.push(...applied.observations)
          changed.opened += applied.delta.opened
          changed.resolved += applied.delta.resolved
          changed.recurred += applied.delta.recurred
          const open = undecidedRules(facts).map((item) => item.code)
          if (open.length) undecided.set(bucket, open)
          if (read.length % 4 === 0 || read.length === selected.length)
            run.progress(`${read.length} of ${selected.length} buckets`)
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker))

      // Only a complete, unscoped, untruncated listing can say a bucket is gone.
      let gone: string[] = []
      if (complete && !stopped && selected.length === scoped.length) {
        const seen = new Set(visible)
        gone = remembered.map((row) => row.name).filter((name) => !seen.has(name) && inScope(name))
      }
      gone.push(...missing)
      if (gone.length) {
        const result = await run.assess.gone(config.id, gone)
        changed.resolved += result.resolved
        observations.push(...result.observations)
      }

      let attribution:
        | {
            status: 'ok' | 'denied' | 'unsupported' | 'error'
            events: { at: string; event: string; actor: string }[]
            from: string
            to: string
            days: number
            truncated: boolean
          }
        | undefined
      if (aws && postureChanges.length) {
        const buckets = [...new Set(postureChanges.map((change) => change.bucket))].slice(0, 6)
        const looked = await Promise.all(
          buckets.map((bucket) =>
            attribute(
              deps.providers.cloudTrail(
                config,
                regionOf.get(bucket) ?? config.region ?? 'us-east-1',
              ),
              bucket,
              run.signal,
            ),
          ),
        )
        const rank = { ok: 0, unsupported: 1, denied: 2, error: 3 } as const
        const first = looked[0]
        attribution = {
          status: looked.reduce<'ok' | 'denied' | 'unsupported' | 'error'>(
            (worst, item) => (rank[item.status] > rank[worst] ? item.status : worst),
            'ok',
          ),
          events: looked.flatMap((item) => item.events).slice(0, 20),
          from: first?.from ?? '',
          to: first?.to ?? '',
          days: first?.days ?? 90,
          truncated: looked.some((item) => item.truncated),
        }
      }

      const issues = await deps.estate.issueRows(config.id, deps.lang(), VIEW_ISSUES)
      const undecidedRows = [...undecided.entries()].flatMap(([bucket, codes]) =>
        codes.map((code) => ({
          bucket,
          code,
          title: BY_CODE.has(code) ? ruleTitle(BY_CODE.get(code)!, deps.lang()) : code,
        })),
      )
      const issueTotal = await deps.db.countOpenIssues(config.id)
      read.sort((a, b) => a.bucket.localeCompare(b.bucket))
      const withCapacity = read.some((facts) => facts.capacity)
      const table: Table = {
        columns: [
          'Bucket',
          'Public',
          'Encryption',
          'Access block',
          'Lifecycle',
          'Region',
          ...(withCapacity ? ['Size', 'Objects', '≈ $/month'] : []),
        ],
        rows: read.map((facts) => {
          const memory = rememberable(facts)
          return [
            facts.bucket,
            exposure(facts.exposure.verdict),
            dimension(facts.encryption.status),
            dimension(String(memory.public_access_block_status)),
            dimension(facts.lifecycle.status),
            facts.region,
            ...(withCapacity
              ? facts.capacity
                ? [
                    formatBytes(facts.capacity.bytes),
                    facts.capacity.objects ?? null,
                    facts.capacity.monthlyUsd,
                  ]
                : [null, null, null]
              : []),
          ]
        }),
        truncated: scoped.length > selected.length,
      }
      const totals = withCapacity
        ? read.reduce(
            (sum, facts) => ({
              bytes: sum.bytes + (facts.capacity?.bytes ?? 0),
              objects: sum.objects + (facts.capacity?.objects ?? 0),
              monthlyUsd:
                Math.round((sum.monthlyUsd + (facts.capacity?.monthlyUsd ?? 0)) * 100) / 100,
              buckets: sum.buckets + (facts.capacity ? 1 : 0),
            }),
            { bytes: 0, objects: 0, monthlyUsd: 0, buckets: 0 },
          )
        : null
      const denied = read.filter((f) => f.head === 'access_denied').map((f) => f.bucket)
      const unknown = read.filter((f) => f.exposure.verdict === null).map((f) => f.bucket)
      const publicBuckets = read.filter((f) => f.exposure.verdict === true).map((f) => f.bucket)
      const pending = selected.length - read.length - missing.length
      const accountPab = accountState(account, aws)

      const lines = [
        `Surveyed ${config.name}: ${read.length} of ${scoped.length} bucket(s) read.`,
        publicBuckets.length
          ? `Public: ${publicBuckets.slice(0, 20).join(', ')}${publicBuckets.length > 20 ? ` and ${publicBuckets.length - 20} more` : ''}.`
          : unknown.length
            ? `No bucket proved public; exposure is undecided for ${unknown.length}: ${unknown.slice(0, 10).join(', ')}.`
            : 'No bucket is publicly exposed.',
        aws
          ? `Account public access block: ${accountPab}.`
          : 'S3-compatible endpoint: no account-wide block or CloudWatch capacity.',
        `Issues: ${changed.opened} opened, ${changed.resolved} resolved, ${changed.recurred} recurred; ${issueTotal} open now.`,
      ]
      if (totals) {
        const top = [...read]
          .filter((f) => f.capacity)
          .sort((a, b) => (b.capacity?.bytes ?? 0) - (a.capacity?.bytes ?? 0))
          .slice(0, 5)
          .map(
            (f) =>
              `${f.bucket} ${formatBytes(f.capacity!.bytes)}${f.capacity!.growthBytes ? ` (+${formatBytes(Math.max(0, f.capacity!.growthBytes))} in 14 days)` : ''}`,
          )
        lines.push(
          `Capacity (CloudWatch, ${totals.buckets} buckets): ${formatBytes(totals.bytes)}, ${totals.objects} objects, about $${totals.monthlyUsd}/month storage at list price. Largest: ${top.join('; ')}.`,
        )
      } else if (aws && capacityStatus !== 'available')
        lines.push(
          `Capacity could not be read from CloudWatch (${capacityStatus.replace('_', ' ')}).`,
        )
      if (undecided.size)
        lines.push(
          `Undecided because a read was blind: ${[...undecided.entries()]
            .slice(0, 8)
            .map(([bucket, codes]) => `${bucket} (${codes.join(', ')})`)
            .join('; ')}.`,
        )
      if (denied.length)
        lines.push(`Access denied on ${denied.length}: ${denied.slice(0, 20).join(', ')}.`)
      if (pending > 0)
        lines.push(
          `${pending} bucket(s) were not read before the survey stopped; survey again to read them (longest unread first).`,
        )
      if (scoped.length > selected.length)
        lines.push(`Only ${selected.length} of ${scoped.length} buckets were surveyed this time.`)
      if (refused.length)
        lines.push(`${refused.length} bucket(s) are outside this account's scope.`)
      if (gone.length) lines.push(`No longer listed: ${gone.join(', ')}.`)
      if (postureChanges.length)
        lines.push(
          `Changed since the last reading: ${postureChanges
            .slice(0, 8)
            .map((change) => `${change.bucket} ${change.field} ${change.before} → ${change.after}`)
            .join('; ')}.${
            attribution
              ? attribution.events.length
                ? ` CloudTrail (${attribution.days} days${attribution.truncated ? ', truncated' : ''}): ${attribution.events
                    .map((event) => `${event.event} by ${event.actor} at ${event.at}`)
                    .join('; ')}.`
                : attribution.status === 'ok'
                  ? ` CloudTrail: no matching management event in the last ${attribution.days} days${attribution.truncated ? ' (truncated)' : ''}.`
                  : ` CloudTrail attribution: ${attribution.status} (${attribution.days}-day window).`
              : ''
          }`,
        )

      return {
        model: lines.join('\n'),
        target: config.name,
        note: `${read.length} bucket${read.length === 1 ? '' : 's'}${
          changed.opened ? ` · ${changed.opened} new issue${changed.opened === 1 ? '' : 's'}` : ''
        }${pending > 0 ? ` · ${pending} pending` : ''}`,
        view: {
          kind: 'survey' as const,
          provider: config.name,
          providerId: config.id,
          scoped: Boolean(args.buckets?.length),
          buckets: table,
          issues,
          issueTotal,
          undecided: undecidedRows,
          permissions: [
            ...read.flatMap((facts) => permissionGaps(facts)),
            ...(aws && account.pab.status === 'access_denied'
              ? [
                  {
                    bucket: '',
                    item: 'account public access block',
                    action: 's3:GetAccountPublicAccessBlock',
                  },
                ]
              : []),
          ],
          observations,
          account: { pab: accountPab },
          accountRead:
            aws && (account.pab.status === 'available' || account.pab.status === 'not_configured'),
          capacity: totals,
          postureChanges: postureChanges.slice(0, 80),
          ...(attribution ? { attribution } : {}),
          coverage: {
            visible: visible.length,
            processed: read.length,
            truncated: scoped.length > selected.length,
            pending: Math.max(0, pending),
            denied,
            unknown,
            gone,
          },
          changed,
        },
      }
    },
  })
}
