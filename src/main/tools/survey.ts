import { ListBucketsCommand } from '@aws-sdk/client-s3'
import type { Table } from '@shared/contract'
import { evaluatePosture } from '../estate/rules'
import { type Posture, postureProjection, snapshot } from '../s3/posture'
import { agentTool, limitParam, providerParam, type ToolDeps, Type } from './policy'

const HARD_MAX_BUCKETS = 500

function exposure(value: boolean | null): string {
  return value === true ? 'public' : value === false ? 'no' : 'unknown'
}

function dimension(value: string): string {
  return value === 'available' ? 'on' : value === 'not_configured' ? 'off' : '?'
}

async function pool<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await worker(items[index]!)
    }
  })
  await Promise.all(runners)
}

export function surveyTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'survey',
    description:
      'Survey a storage account read-only: list its buckets, record each bucket’s exposure and configuration posture, and open or resolve Issues. Start here.',
    parameters: Type.Object({
      provider_id: providerParam,
      limit: limitParam(HARD_MAX_BUCKETS),
    }),
    timeoutMs: 240_000,
    target: () => '',
    run: async (args, run) => {
      const { config, client } = await run.provider(args.provider_id)
      await run.setTarget(config.name)
      const response = await client.send(new ListBucketsCommand({}), { abortSignal: run.signal })
      const visible = (response.Buckets ?? [])
        .map((bucket) => bucket.Name)
        .filter((name): name is string => Boolean(name))
      const scoped = visible.filter(
        (name) => config.scope.buckets.length === 0 || config.scope.buckets.includes(name),
      )
      const limit = Math.max(1, Math.min(args.limit ?? HARD_MAX_BUCKETS, HARD_MAX_BUCKETS))
      const selected = scoped.slice(0, limit)
      run.progress(`Surveying ${selected.length} buckets`)

      const postures: Posture[] = []
      let done = 0
      await pool(selected, 4, async (bucket) => {
        if (run.signal.aborted) return
        postures.push(await snapshot(client, config.region, bucket))
        done += 1
        if (done % 5 === 0) run.progress(`${done} of ${selected.length} buckets`)
      })

      const changed = { opened: 0, resolved: 0, recurred: 0 }
      for (const posture of postures) {
        await deps.db.upsertBucket(config.id, posture.bucket, postureProjection(posture))
        const delta = await deps.estate.apply(
          config.id,
          posture.bucket,
          evaluatePosture(posture),
          run.conversationId,
        )
        changed.opened += delta.opened
        changed.resolved += delta.resolved
        changed.recurred += delta.recurred
      }

      const issues = await deps.estate.issueRows(config.id, deps.lang(), 100)
      const rows = postures
        .sort((a, b) => a.bucket.localeCompare(b.bucket))
        .map((p) => [
          p.bucket,
          exposure(p.publicly_exposed),
          dimension(p.encryption_status),
          dimension(p.lifecycle_status),
          dimension(p.public_access_block_status),
        ])
      const table: Table = {
        columns: ['Bucket', 'Public', 'Encryption', 'Lifecycle', 'Public access block'],
        rows,
        truncated: scoped.length > selected.length,
      }
      const denied = postures
        .filter((p) => p.access_status === 'access_denied')
        .map((p) => p.bucket)
      const unknown = postures.filter((p) => p.publicly_exposed === null).map((p) => p.bucket)
      const publicBuckets = postures.filter((p) => p.publicly_exposed === true).map((p) => p.bucket)
      const noEncryption = postures.filter((p) => p.encryption_status === 'not_configured').length
      const noLifecycle = postures.filter((p) => p.lifecycle_status === 'not_configured').length

      const lines = [
        `Surveyed ${config.name}: ${postures.length} of ${scoped.length} bucket(s) processed.`,
        publicBuckets.length
          ? `Public: ${publicBuckets.join(', ')}.`
          : unknown.length
            ? `No bucket proved public; exposure could not be decided for ${unknown.length}.`
            : 'No bucket is publicly exposed.',
        `${noEncryption} without default encryption, ${noLifecycle} without lifecycle rules.`,
        `Issues: ${changed.opened} opened, ${changed.resolved} resolved, ${changed.recurred} recurred.`,
      ]
      if (denied.length) lines.push(`Access denied on ${denied.length}: ${denied.join(', ')}.`)
      if (scoped.length > selected.length) {
        lines.push(`Only the first ${selected.length} of ${scoped.length} buckets were surveyed.`)
      }

      return {
        model: lines.join('\n'),
        target: config.name,
        note: `${postures.length} bucket${postures.length === 1 ? '' : 's'}${
          changed.opened ? ` · ${changed.opened} issue${changed.opened === 1 ? '' : 's'}` : ''
        }`,
        view: {
          kind: 'survey' as const,
          provider: config.name,
          buckets: table,
          issues,
          coverage: {
            visible: visible.length,
            processed: postures.length,
            truncated: scoped.length > selected.length,
            denied,
            unknown,
          },
          changed,
        },
      }
    },
  })
}
