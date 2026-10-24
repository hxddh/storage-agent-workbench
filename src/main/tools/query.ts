/**
 * Read-only code mode.
 *
 * Some questions span more objects or buckets than a fixed tool can carry to
 * the model — the largest prefixes of a bucket, data untouched for a year,
 * buckets by storage class. The model writes a short script; it runs in a
 * QuickJS sandbox (no fetch, no require, no process, no timers) whose only
 * capabilities are the read-only primitives below. Every primitive checks the
 * account scope, every call counts against a budget, and only the script's
 * returned rows reach the model and the page.
 */
import {
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { CodemodeSandbox, type CodemodeTool } from '@earendil-works/pi-codemode'
import type { Chart, Table } from '@shared/contract'
import { decide } from '../estate/rules'
import type { ProviderConfig } from '../providers'
import { readBucket } from '../s3/facts'
import { readCapacity } from '../s3/metrics'
import { redact } from '../security/redact'
import { agentTool, assertInScope, providerParam, type ToolDeps, Type } from './policy'

export const QUERY_BUDGET = {
  calls: 2000,
  listed: 500_000,
  timeoutMs: 120_000,
  memoryBytes: 256 * 1024 * 1024,
  rows: 500,
  modelRows: 40,
  codeChars: 6000,
}

/** The primitives as the model sees them, in the tool description. */
export const QUERY_API = `Primitives (all read-only, all async, all scoped to the account):
  buckets(): {name, region}[]
  list({bucket, prefix?, delimiter?, kind?: "objects"|"versions"|"uploads", token?, max?}): {items: {key, size, modified, storageClass, versionId?, latest?, deleteMarker?}[], prefixes: string[], next: string|null}   // max ≤ 1000 per page
  head({bucket, key}): {size, contentType, modified, storageClass, encryption, versionId, metadataKeys}
  config({bucket, aspect?: "security"|"lifecycle"|"observability"}): {exposure, statuses, issues}   // issues: rule codes the reading proves
  capacity({bucket}): {bytes, objects, byClass, growthBytes, monthlyUsd} | null   // AWS CloudWatch only
  estate(): {buckets: {name, readAt, posture}[], issues: {bucket, code, severity, status}[]}
Call them as tools.list({...}) etc. Return an array of flat rows (objects with string/number/boolean values), or {rows, chart: {label: "<column>", value: "<numeric column>"}}. text("…") adds a line of output.
Budget per script: ${QUERY_BUDGET.calls} calls, ${QUERY_BUDGET.listed.toLocaleString('en-US')} listed items, ${QUERY_BUDGET.timeoutMs / 1000} s.`

class BudgetError extends Error {}

function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return redact(value).slice(0, 500)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return redact(JSON.stringify(value)).slice(0, 500)
}

/** The script's value as a table and an optional bar chart. */
export function toTable(value: unknown): { table: Table; chart: Chart | null } {
  let rows: unknown[] = []
  let chartSpec: { label?: string; value?: string } | undefined
  if (Array.isArray(value)) rows = value
  else if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { rows?: unknown }).rows)
  ) {
    rows = (value as { rows: unknown[] }).rows
    chartSpec = (value as { chart?: { label?: string; value?: string } }).chart
  } else if (value !== undefined && value !== null) rows = [{ value }]
  const objects = rows.map((row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? (row as Record<string, unknown>)
      : { value: row },
  )
  const columns: string[] = []
  for (const row of objects.slice(0, 200)) {
    for (const key of Object.keys(row))
      if (!columns.includes(key) && columns.length < 12) columns.push(key)
  }
  const table: Table = {
    columns,
    rows: objects
      .slice(0, QUERY_BUDGET.rows)
      .map((row) => columns.map((column) => cell(row[column]))),
    truncated: objects.length > QUERY_BUDGET.rows,
  }
  let chart: Chart | null = null
  const label = chartSpec?.label ?? (columns.length === 2 ? columns[0] : undefined)
  const metric = chartSpec?.value ?? (columns.length === 2 ? columns[1] : undefined)
  if (label && metric && columns.includes(label) && columns.includes(metric)) {
    const li = columns.indexOf(label)
    const mi = columns.indexOf(metric)
    const points = table.rows.slice(0, 20).filter((row) => typeof row[mi] === 'number')
    if (points.length >= 2)
      chart = {
        type: 'bar',
        labels: points.map((row) => String(row[li] ?? '')),
        values: points.map((row) => row[mi] as number),
      }
  }
  return { table, chart }
}

interface Context {
  deps: ToolDeps
  config: ProviderConfig
  client: S3Client
  signal: AbortSignal
  regional?: (region: string) => S3Client
  usage: { calls: number; listed: number }
  /** Buckets the script read: they ground what the verdict says about it. */
  touched: Set<string>
}

function primitives(ctx: Context): CodemodeTool[] {
  const { deps, config, client } = ctx
  const aws = deps.providers.isAws(config)
  const spend = (listed = 0) => {
    ctx.usage.calls += 1
    ctx.usage.listed += listed
    if (ctx.usage.calls > QUERY_BUDGET.calls)
      throw new BudgetError(`Call budget of ${QUERY_BUDGET.calls} reached.`)
    if (ctx.usage.listed > QUERY_BUDGET.listed)
      throw new BudgetError(`Listing budget of ${QUERY_BUDGET.listed} items reached.`)
  }
  const bucketArg = (args: unknown): string => {
    const bucket = String((args as { bucket?: unknown })?.bucket ?? '')
    if (!bucket) throw new Error('bucket is required.')
    assertInScope(config, bucket)
    ctx.touched.add(bucket)
    return bucket
  }
  const send = <T>(command: unknown) =>
    client.send(command as never, { abortSignal: ctx.signal }) as Promise<T>

  return [
    {
      name: 'buckets',
      description: 'Buckets in scope with their region.',
      execute: async () => {
        spend()
        const response = await send<{ Buckets?: { Name?: string; BucketRegion?: string }[] }>(
          new ListBucketsCommand({}),
        )
        const remembered = new Map(
          (await deps.db.listBuckets(config.id)).map((row) => [row.name, row.region]),
        )
        return (response.Buckets ?? [])
          .map((b) => b.Name ?? '')
          .filter(
            (name) =>
              name && (config.scope.buckets.length === 0 || config.scope.buckets.includes(name)),
          )
          .map((name) => ({ name, region: remembered.get(name) ?? config.region }))
      },
    },
    {
      name: 'list',
      description: 'One page of objects, versions or incomplete uploads.',
      execute: async (args) => {
        const bucket = bucketArg(args)
        const a = args as {
          prefix?: string
          delimiter?: string
          kind?: string
          token?: string
          max?: number
        }
        const max = Math.max(1, Math.min(Number(a.max ?? 1000) || 1000, 1000))
        const prefix = a.prefix ? String(a.prefix) : undefined
        const delimiter = a.delimiter ? String(a.delimiter) : undefined
        if (a.kind === 'versions') {
          const [keyMarker, versionMarker] = a.token ? String(a.token).split('\u0000') : []
          const r = await send<{
            Versions?: {
              Key?: string
              Size?: number
              LastModified?: Date
              StorageClass?: string
              VersionId?: string
              IsLatest?: boolean
            }[]
            DeleteMarkers?: {
              Key?: string
              LastModified?: Date
              VersionId?: string
              IsLatest?: boolean
            }[]
            CommonPrefixes?: { Prefix?: string }[]
            IsTruncated?: boolean
            NextKeyMarker?: string
            NextVersionIdMarker?: string
          }>(
            new ListObjectVersionsCommand({
              Bucket: bucket,
              Prefix: prefix,
              Delimiter: delimiter,
              MaxKeys: max,
              KeyMarker: keyMarker || undefined,
              VersionIdMarker: versionMarker || undefined,
            }),
          )
          const items = [
            ...(r.Versions ?? []).map((v) => ({
              key: v.Key ?? '',
              size: v.Size ?? 0,
              modified: v.LastModified ? new Date(v.LastModified).toISOString() : null,
              storageClass: v.StorageClass ?? 'STANDARD',
              versionId: v.VersionId ?? null,
              latest: Boolean(v.IsLatest),
              deleteMarker: false,
            })),
            ...(r.DeleteMarkers ?? []).map((d) => ({
              key: d.Key ?? '',
              size: 0,
              modified: d.LastModified ? new Date(d.LastModified).toISOString() : null,
              storageClass: null,
              versionId: d.VersionId ?? null,
              latest: Boolean(d.IsLatest),
              deleteMarker: true,
            })),
          ]
          spend(items.length)
          return {
            items,
            prefixes: (r.CommonPrefixes ?? []).map((p) => p.Prefix ?? ''),
            next: r.IsTruncated
              ? `${r.NextKeyMarker ?? ''}\u0000${r.NextVersionIdMarker ?? ''}`
              : null,
          }
        }
        if (a.kind === 'uploads') {
          const [keyMarker, uploadMarker] = a.token ? String(a.token).split('\u0000') : []
          const r = await send<{
            Uploads?: { Key?: string; Initiated?: Date; StorageClass?: string }[]
            CommonPrefixes?: { Prefix?: string }[]
            IsTruncated?: boolean
            NextKeyMarker?: string
            NextUploadIdMarker?: string
          }>(
            new ListMultipartUploadsCommand({
              Bucket: bucket,
              Prefix: prefix,
              Delimiter: delimiter,
              MaxUploads: max,
              KeyMarker: keyMarker || undefined,
              UploadIdMarker: uploadMarker || undefined,
            }),
          )
          const items = (r.Uploads ?? []).map((u) => ({
            key: u.Key ?? '',
            size: 0,
            modified: u.Initiated ? new Date(u.Initiated).toISOString() : null,
            storageClass: u.StorageClass ?? 'STANDARD',
          }))
          spend(items.length)
          return {
            items,
            prefixes: (r.CommonPrefixes ?? []).map((p) => p.Prefix ?? ''),
            next: r.IsTruncated
              ? `${r.NextKeyMarker ?? ''}\u0000${r.NextUploadIdMarker ?? ''}`
              : null,
          }
        }
        const r = await send<{
          Contents?: { Key?: string; Size?: number; LastModified?: Date; StorageClass?: string }[]
          CommonPrefixes?: { Prefix?: string }[]
          IsTruncated?: boolean
          NextContinuationToken?: string
        }>(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: delimiter,
            MaxKeys: max,
            ContinuationToken: a.token ? String(a.token) : undefined,
          }),
        )
        const items = (r.Contents ?? []).map((o) => ({
          key: o.Key ?? '',
          size: o.Size ?? 0,
          modified: o.LastModified ? new Date(o.LastModified).toISOString() : null,
          storageClass: o.StorageClass ?? 'STANDARD',
        }))
        spend(items.length)
        return {
          items,
          prefixes: (r.CommonPrefixes ?? []).map((p) => p.Prefix ?? ''),
          next: r.IsTruncated ? (r.NextContinuationToken ?? null) : null,
        }
      },
    },
    {
      name: 'head',
      description: 'One object’s facts; metadata values are never returned.',
      execute: async (args) => {
        const bucket = bucketArg(args)
        const key = String((args as { key?: unknown })?.key ?? '')
        if (!key) throw new Error('key is required.')
        spend()
        const r = await send<{
          ContentLength?: number
          ContentType?: string
          LastModified?: Date
          StorageClass?: string
          ServerSideEncryption?: string
          VersionId?: string
          Metadata?: Record<string, string>
        }>(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return {
          size: r.ContentLength ?? 0,
          contentType: r.ContentType ?? null,
          modified: r.LastModified ? new Date(r.LastModified).toISOString() : null,
          storageClass: r.StorageClass ?? 'STANDARD',
          encryption: r.ServerSideEncryption ?? null,
          versionId: r.VersionId ?? null,
          metadataKeys: Object.keys(r.Metadata ?? {}),
        }
      },
    },
    {
      name: 'config',
      description:
        'One bucket’s configuration reading: exposure, statuses and the rules it proves.',
      execute: async (args) => {
        const bucket = bucketArg(args)
        const aspect = String((args as { aspect?: unknown })?.aspect ?? 'security')
        const wanted = aspect === 'lifecycle' || aspect === 'observability' ? aspect : 'security'
        spend()
        const facts = await readBucket(client, bucket, {
          aspects: new Set([wanted]),
          signal: ctx.signal,
          regional: ctx.regional,
          defaultRegion: config.region,
          aws,
        })
        const statuses: Record<string, string> = {}
        for (const key of [
          'versioning',
          'encryption',
          'lifecycle',
          'policy',
          'policyStatus',
          'pab',
          'ownership',
          'acl',
          'cors',
          'logging',
        ] as const)
          if (facts[key].status !== 'unread') statuses[key] = facts[key].status
        return {
          region: facts.region,
          exposure:
            facts.exposure.verdict === null
              ? 'unknown'
              : facts.exposure.verdict
                ? 'public'
                : 'not public',
          statuses,
          issues: Object.entries(decide(facts))
            .filter(([, d]) => d.verdict)
            .map(([code]) => code),
        }
      },
    },
    {
      name: 'capacity',
      description:
        'CloudWatch size, objects, storage classes and growth for one bucket (AWS only).',
      execute: async (args) => {
        const bucket = bucketArg(args)
        if (!aws) return null
        spend()
        const region =
          (await deps.db.listBuckets(config.id)).find((row) => row.name === bucket)?.region ??
          config.region
        const result = await readCapacity(
          deps.providers.cloudwatch(config, region),
          [bucket],
          ctx.signal,
        )
        const value = result.capacity.get(bucket)
        return value
          ? {
              bytes: value.bytes,
              objects: value.objects,
              byClass: value.byClass,
              growthBytes: value.growthBytes,
              monthlyUsd: value.monthlyUsd,
            }
          : null
      },
    },
    {
      name: 'estate',
      description: 'What the agent remembers: buckets with their last reading, and Issues.',
      execute: async () => {
        spend()
        const rows = await deps.db.listBuckets(config.id)
        const issues = await deps.db.listIssues({
          providerId: config.id,
          status: 'open',
          limit: 1000,
        })
        return {
          buckets: rows.map((row) => {
            let posture: Record<string, unknown> = {}
            try {
              posture = row.posture_json
                ? (JSON.parse(row.posture_json) as Record<string, unknown>)
                : {}
            } catch {
              posture = {}
            }
            return { name: row.name, readAt: row.posture_at, region: row.region, posture }
          }),
          issues: issues.map((issue) => ({
            bucket: issue.bucket,
            code: issue.code,
            severity: issue.severity,
            status: issue.status,
          })),
        }
      },
    },
  ]
}

/** `timeoutMs` is for tests; the app always runs with the full budget. */
export function queryTool(deps: ToolDeps, timeoutMs = QUERY_BUDGET.timeoutMs) {
  return agentTool(deps, {
    name: 'query',
    description: `Answer a question no other tool can by running a short read-only JavaScript script over the account: largest prefixes, data untouched for a year, objects by storage class, versions piling up, buckets by size. Use it when the answer needs many objects or many buckets; use the other tools for one bucket or one object.\n${QUERY_API}`,
    parameters: Type.Object({
      provider_id: providerParam,
      title: Type.String({ description: 'What the result shows, in a few words, for the page.' }),
      code: Type.String({ description: 'The script body; `return` the rows.' }),
    }),
    timeoutMs: timeoutMs + 15_000,
    target: (args) => args.title.slice(0, 80),
    run: async (args, run) => {
      if (args.code.length > QUERY_BUDGET.codeChars)
        throw new Error(`The script is longer than ${QUERY_BUDGET.codeChars} characters.`)
      const { config, client } = await run.provider(args.provider_id)
      const usage = { calls: 0, listed: 0 }
      const touched = new Set<string>()
      const sandbox = new CodemodeSandbox({
        tools: primitives({
          deps,
          config,
          client,
          signal: run.signal,
          regional: run.regional,
          usage,
          touched,
        }),
        timeoutMs,
        memoryLimitBytes: QUERY_BUDGET.memoryBytes,
      })
      const ticker = setInterval(() => {
        run.progress(`${usage.calls} calls · ${usage.listed.toLocaleString('en-US')} items`)
      }, 1000)
      let result: Awaited<ReturnType<CodemodeSandbox['execute']>>
      try {
        result = await sandbox.execute(args.code, { signal: run.signal })
      } finally {
        clearInterval(ticker)
        await sandbox.close().catch(() => undefined)
      }
      const output = result.output
        .filter((item) => item.type === 'text')
        .map((item) => (item as { text: string }).text)
        .join('\n')
        .slice(0, 2000)
      if (!result.ok) {
        const reason =
          result.error.kind === 'timeout'
            ? `The script ran past ${Math.round(timeoutMs / 1000)} s.`
            : result.error.kind === 'aborted'
              ? 'The script was stopped.'
              : `${result.error.name ?? 'Error'}: ${result.error.message}`
        throw new Error(
          `${reason}${output ? `\nOutput before it failed:\n${output}` : ''}`.slice(0, 1500),
        )
      }
      const { table, chart } = toTable(result.value)
      const preview = [
        table.columns.join('\t'),
        ...table.rows
          .slice(0, QUERY_BUDGET.modelRows)
          .map((row) => row.map((v) => (v === null ? '' : String(v))).join('\t')),
      ].join('\n')
      const lines = [
        `${args.title}: ${table.rows.length}${table.truncated ? '+' : ''} row(s) from ${usage.calls} read-only call(s) over ${usage.listed.toLocaleString('en-US')} listed item(s).`,
        table.rows.length ? preview : 'The script returned no rows.',
        ...(table.rows.length > QUERY_BUDGET.modelRows
          ? [`(${table.rows.length - QUERY_BUDGET.modelRows} more rows are on the page.)`]
          : []),
        ...(output ? [`Output:\n${output}`] : []),
      ]
      return {
        model: lines.join('\n'),
        note: `${table.rows.length} row${table.rows.length === 1 ? '' : 's'} · ${usage.calls} call${usage.calls === 1 ? '' : 's'}`,
        view: {
          kind: 'query' as const,
          title: args.title.slice(0, 120),
          code: args.code.slice(0, QUERY_BUDGET.codeChars),
          rows: table,
          chart,
          output: output || null,
          calls: usage.calls,
          listed: usage.listed,
          buckets: [...touched].slice(0, 200),
        },
      }
    },
  })
}
