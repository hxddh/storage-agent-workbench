import { ListBucketsCommand } from '@aws-sdk/client-s3'
import type { Observation, Table } from '@shared/contract'
import { decide, undecidedRules } from '../estate/rules'
import { type BucketFacts, readBucket, rememberable } from '../s3/facts'
import { isAbort } from '../s3/status'
import { agentTool, limitParam, providerParam, type ToolDeps, Type } from './policy'

const HARD_MAX_BUCKETS = 500
const CONCURRENCY = 8
const TIMEOUT_MS = 300_000
/** Stop starting buckets this long before the tool's timeout, and report the rest as pending. */
const RESERVE_MS = 20_000

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

export function surveyTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'survey',
    description:
      'Survey a storage account read-only: list its buckets, read each bucket’s exposure, encryption, public access block, CORS, policy and lifecycle, and open or resolve Issues. Pass `buckets` to re-read only those (for example after the user applied a fix).',
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
      const inScope = (name: string) =>
        config.scope.buckets.length === 0 || config.scope.buckets.includes(name)

      let visible: string[]
      let complete = false
      if (args.buckets?.length) {
        visible = [...new Set(args.buckets)]
      } else {
        const response = await client.send(new ListBucketsCommand({}), { abortSignal: run.signal })
        visible = (response.Buckets ?? [])
          .map((bucket) => bucket.Name)
          .filter((name): name is string => Boolean(name))
        complete = true
      }
      const scoped = visible.filter(inScope)
      const refused = visible.filter((name) => !inScope(name))
      const limit = Math.max(1, Math.min(args.limit ?? HARD_MAX_BUCKETS, HARD_MAX_BUCKETS))
      const selected = scoped.slice(0, limit)
      run.progress(`0 of ${selected.length} buckets`)

      const read: BucketFacts[] = []
      const observations: Observation[] = []
      const changed = { opened: 0, resolved: 0, recurred: 0 }
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
          await deps.db.upsertBucket(config.id, bucket, rememberable(facts), facts.region)
          const applied = await deps.estate.apply(
            config.id,
            bucket,
            decide(facts),
            run.conversationId,
          )
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
        const known = (await deps.db.listBuckets(config.id)).map((row) => row.name)
        const seen = new Set(visible)
        gone = known.filter((name) => !seen.has(name) && inScope(name))
      }
      gone.push(...missing)
      if (gone.length) {
        const result = await deps.estate.gone(config.id, gone, run.conversationId)
        changed.resolved += result.resolved
        observations.push(...result.observations)
      }

      const issues = await deps.estate.issueRows(config.id, deps.lang(), 100)
      read.sort((a, b) => a.bucket.localeCompare(b.bucket))
      const table: Table = {
        columns: ['Bucket', 'Public', 'Encryption', 'Access block', 'Lifecycle', 'Region'],
        rows: read.map((facts) => {
          const memory = rememberable(facts)
          return [
            facts.bucket,
            exposure(facts.exposure.verdict),
            dimension(facts.encryption.status),
            dimension(String(memory.public_access_block_status)),
            dimension(facts.lifecycle.status),
            facts.region,
          ]
        }),
        truncated: scoped.length > selected.length,
      }
      const denied = read.filter((f) => f.head === 'access_denied').map((f) => f.bucket)
      const unknown = read.filter((f) => f.exposure.verdict === null).map((f) => f.bucket)
      const publicBuckets = read.filter((f) => f.exposure.verdict === true).map((f) => f.bucket)
      const pending = selected.length - read.length - missing.length

      const lines = [
        `Surveyed ${config.name}: ${read.length} of ${scoped.length} bucket(s) read.`,
        publicBuckets.length
          ? `Public: ${publicBuckets.join(', ')}.`
          : unknown.length
            ? `No bucket proved public; exposure is undecided for ${unknown.length}: ${unknown.slice(0, 10).join(', ')}.`
            : 'No bucket is publicly exposed.',
        `Issues: ${changed.opened} opened, ${changed.resolved} resolved, ${changed.recurred} recurred; ${issues.filter((i) => i.status === 'open').length} open now.`,
      ]
      if (undecided.size)
        lines.push(
          `Undecided because a read was blind: ${[...undecided.entries()]
            .slice(0, 8)
            .map(([bucket, codes]) => `${bucket} (${codes.join(', ')})`)
            .join('; ')}.`,
        )
      if (denied.length) lines.push(`Access denied on ${denied.length}: ${denied.join(', ')}.`)
      if (pending > 0)
        lines.push(
          `${pending} bucket(s) were not read before the survey stopped; the question stays open for them.`,
        )
      if (scoped.length > selected.length)
        lines.push(`Only the first ${selected.length} of ${scoped.length} buckets were surveyed.`)
      if (refused.length)
        lines.push(`${refused.length} bucket(s) are outside this account's scope.`)
      if (gone.length) lines.push(`No longer listed: ${gone.join(', ')}.`)

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
          buckets: table,
          issues,
          observations,
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
