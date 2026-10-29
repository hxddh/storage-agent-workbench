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
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketInventoryConfigurationsCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { CodemodeSandbox, type CodemodeTool } from '@earendil-works/pi-codemode'
import type { AccessCoverage, Chart, Table } from '@shared/contract'
import { parse as parseCsv } from 'csv-parse/sync'
import { parquetReadObjects } from 'hyparquet'
import { AggregationError, aggregate, type DatasetKind, preview } from '../analysis/aggregate'
import { datasetBytes, importDataset, importInventoryFiles } from '../analysis/import'
import { decide } from '../estate/rules'
import type { ProviderConfig } from '../providers'
import { type AccessSession, readAccess } from '../s3/access'
import { readAccount, UNREAD_ACCOUNT } from '../s3/account'
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
  principal({bucket?, principal?, limit?}): {bucket?, paths, coverage}   // effective access for one bucket, or remembered buckets a principal reaches
  inventory({bucket, maxRows?, full?}): {file, rows, format, manifestAt, truncated, note}   // one manifest page, or full?: import every manifest file into a local dataset for aggregate()
  dataset({file, kind?}): {file, kind, rows, columns}   // import one attached access log or inventory
  aggregate({file, metric, groupBy?, filters?, limit?}): {rows}
Call them as tools.list({...}) etc. dataset and aggregate are the only way to read an attached file; raw rows never reach you. Return an array of flat rows (objects with string/number/boolean values), or {rows, chart: {label: "<column>", value: "<numeric column>"}}. text("…") adds a line of output.
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
  conversationId: string
  deps: ToolDeps
  config: ProviderConfig
  client: S3Client
  signal: AbortSignal
  regional?: (region: string) => S3Client
  account?: () => Promise<import('../s3/account').AccountFacts>
  usage: {
    calls: number
    listed: number
    coverage?: AccessCoverage
    blind?: { source: string; status: string }[]
  }
  /** Buckets the script read: they ground what the verdict says about it. */
  touched: Set<string>
  datasets: Map<string, { kind: DatasetKind; path: string; rows: number }>
}

function primitives(ctx: Context): CodemodeTool[] {
  const { deps, config, client } = ctx
  const aws = deps.providers.isAws(config)
  const charge = (calls: number, listed = 0) => {
    ctx.usage.calls += Math.max(0, calls)
    ctx.usage.listed += listed
    if (ctx.usage.calls > QUERY_BUDGET.calls)
      throw new BudgetError(`Call budget of ${QUERY_BUDGET.calls} reached.`)
    if (ctx.usage.listed > QUERY_BUDGET.listed)
      throw new BudgetError(`Listing budget of ${QUERY_BUDGET.listed} items reached.`)
  }
  const spend = (listed = 0) => charge(1, listed)
  const bucketArg = (args: unknown): string => {
    const bucket = String((args as { bucket?: unknown })?.bucket ?? '')
    if (!bucket) throw new Error('bucket is required.')
    assertInScope(config, bucket)
    ctx.touched.add(bucket)
    return bucket
  }
  const settle = (reserved: number, actual: number) => {
    ctx.usage.listed = Math.max(0, ctx.usage.listed - Math.max(0, reserved - actual))
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
        // Charge the page before the request: a script cannot fan out 2,000
        // listings and only then discover it passed the budget.
        spend(max)
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
          const prefixes = (r.CommonPrefixes ?? []).map((p) => p.Prefix ?? '')
          settle(max, items.length + prefixes.length)
          return {
            items,
            prefixes,
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
        const prefixes = (r.CommonPrefixes ?? []).map((p) => p.Prefix ?? '')
        settle(max, items.length + prefixes.length)
        return {
          items,
          prefixes,
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
          account: (await ctx.account?.()) ?? UNREAD_ACCOUNT,
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
      name: 'dataset',
      description:
        'Import one attached access log or object inventory into a local read-only SQLite dataset.',
      execute: async (args) => {
        const file = String((args as { file?: unknown })?.file ?? '')
        if (!file) throw new Error('file is required.')
        if (!/^[^/\\]{1,200}$/.test(file)) throw new Error('file must be a plain file name.')
        const uploads = deps.uploadsDir(ctx.conversationId)
        const path = join(uploads, file)
        if (!existsSync(path)) {
          const available = existsSync(uploads) ? readdirSync(uploads).slice(0, 20) : []
          throw new Error(
            available.length
              ? `No attached file named '${file}'. Available: ${available.join(', ')}.`
              : 'No files are attached to this task.',
          )
        }
        const stat = statSync(path)
        const id = createHash('sha1')
          .update(`${ctx.conversationId}:${file}:${stat.size}:${stat.mtimeMs}`)
          .digest('hex')
          .slice(0, 16)
        const datasetPath = join(deps.datasetsDir(ctx.conversationId), `${id}.sqlite`)
        let kind: DatasetKind = 'access_log'
        let rows = 0
        if (!existsSync(datasetPath)) {
          const requested = (args as { kind?: unknown })?.kind
          const result = await importDataset({
            filePath: path,
            destPath: datasetPath,
            ...(requested === 'inventory' || requested === 'access_log' ? { kind: requested } : {}),
          })
          kind = result.kind
          rows = result.rows
          await deps.db.insertDataset({
            id,
            conversation_id: ctx.conversationId,
            kind,
            path: datasetPath,
            rows,
            bytes: datasetBytes(datasetPath),
          })
        } else {
          const known = await deps.db.listDatasets(ctx.conversationId)
          kind = (known.find((row) => row.id === id)?.kind as DatasetKind) ?? 'access_log'
          rows = known.find((row) => row.id === id)?.rows ?? 0
        }
        ctx.datasets.set(file, { kind, path: datasetPath, rows })
        const sample = preview(datasetPath, kind, 3)
        return { file, kind, rows, columns: sample.columns }
      },
    },
    {
      name: 'aggregate',
      description:
        'A whitelisted aggregate over one dataset imported in this script. Access metrics: count, sum_bytes, avg_bytes, min_bytes, max_bytes, avg_latency_ms, p50/p95/p99_latency_ms, max_latency_ms, distinct_ips, distinct_keys. Inventory metrics: count, total_size, avg_size, max_size, min_size, distinct_prefixes, distinct_storage_classes.',
      execute: async (args) => {
        const a = args as {
          file?: unknown
          metric?: unknown
          groupBy?: unknown
          filters?: unknown
          limit?: unknown
        }
        const file = String(a.file ?? '')
        const dataset = ctx.datasets.get(file)
        if (!dataset) throw new Error(`Import '${file}' with dataset() first.`)
        const metric = String(a.metric ?? '')
        if (!metric) throw new Error('metric is required.')
        const filters =
          a.filters && typeof a.filters === 'object' && !Array.isArray(a.filters)
            ? (a.filters as Record<string, string>)
            : null
        try {
          const result = aggregate(dataset.path, dataset.kind, {
            metric,
            groupBy: a.groupBy ? String(a.groupBy) : null,
            filters,
            limit: Number(a.limit ?? 20),
          })
          return {
            rows: result.groups
              ? result.groups.map((group) => ({ group: group.group, value: group.value }))
              : [{ value: result.value }],
            metric,
            groupBy: result.groupBy,
          }
        } catch (error) {
          if (error instanceof AggregationError) throw new Error(error.message)
          throw error
        }
      },
    },
    {
      name: 'inventory',
      description:
        'The latest S3 Inventory manifest for one bucket. Reads a bounded page of CSV or Parquet rows; a larger file is reported instead of loaded whole.',
      execute: async (args) => {
        const bucket = bucketArg(args)
        const maxRows = Math.max(
          1,
          Math.min(Number((args as { maxRows?: unknown }).maxRows ?? 100) || 100, 1000),
        )
        spend()
        const configs = await send<{
          InventoryConfigurationList?: {
            Id?: string
            IsEnabled?: boolean
            Destination?: {
              S3BucketDestination?: { Bucket?: string; Prefix?: string; Format?: string }
            }
            Schedule?: { Frequency?: string }
          }[]
        }>(new ListBucketInventoryConfigurationsCommand({ Bucket: bucket }))
        const inventoryConfig = (configs.InventoryConfigurationList ?? []).find(
          (item) => item.IsEnabled,
        )
        const destination = inventoryConfig?.Destination?.S3BucketDestination
        const destinationBucket = destination?.Bucket?.replace(/^arn:aws:s3:::/, '')
        if (!inventoryConfig || !destinationBucket)
          return {
            rows: [],
            format: null,
            manifestAt: null,
            truncated: false,
            note: 'No enabled inventory configuration.',
          }
        const prefix = destination?.Prefix ?? ''
        if (destinationBucket) assertInScope(config, destinationBucket)
        const objects: { Key?: string; LastModified?: Date; Size?: number }[] = []
        let listingToken: string | undefined
        let listingTruncated = false
        for (let page = 0; page < 10; page += 1) {
          const listed = await send<{
            Contents?: { Key?: string; LastModified?: Date; Size?: number }[]
            NextContinuationToken?: string
          }>(
            new ListObjectsV2Command({
              Bucket: destinationBucket,
              Prefix: prefix,
              MaxKeys: 1000,
              ContinuationToken: listingToken,
            }),
          )
          objects.push(...(listed.Contents ?? []))
          listingToken = listed.NextContinuationToken
          if (!listingToken) break
          if (page === 9) listingTruncated = true
        }
        const fileSize = (key: string) => objects.find((item) => item.Key === key)?.Size ?? 0
        const manifestKey = objects
          .filter((item) => item.Key?.endsWith('/manifest.json') || item.Key === 'manifest.json')
          .sort(
            (a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0),
          )[0]?.Key
        if (!manifestKey)
          return {
            rows: [],
            format: destination?.Format ?? null,
            manifestAt: null,
            truncated: false,
            note: 'The inventory has no manifest yet.',
          }
        const manifestResponse = await send<{ Body?: { transformToString(): Promise<string> } }>(
          new GetObjectCommand({ Bucket: destinationBucket, Key: manifestKey }),
        )
        const manifestText =
          (await manifestResponse.Body?.transformToString())?.slice(0, 2_000_000) ?? ''
        let manifest: {
          creationTimestamp?: string
          fileFormat?: string
          files?: { key: string }[]
          sourceBucket?: string
        } = {}
        try {
          manifest = JSON.parse(manifestText) as typeof manifest
        } catch {
          return {
            rows: [],
            format: destination?.Format ?? null,
            manifestAt: null,
            truncated: false,
            note: 'The manifest is not valid JSON.',
          }
        }
        const format = (manifest.fileFormat ?? destination?.Format ?? '').toUpperCase()
        const file = manifest.files?.[0]?.key
        if (!file)
          return {
            rows: [],
            format,
            manifestAt: manifest.creationTimestamp ?? null,
            truncated: false,
            note: 'The manifest lists no inventory files.',
          }
        if (format && !['CSV', 'PARQUET'].includes(format))
          return {
            rows: [],
            format,
            manifestAt: manifest.creationTimestamp ?? null,
            truncated: false,
            note: `Inventory format ${format} is not readable.`,
          }
        if ((args as { full?: unknown }).full === true) {
          const keys = (manifest.files ?? []).flatMap((item) => (item.key ? [item.key] : []))
          const selected = keys.slice(0, 1000)
          let truncated = keys.length > selected.length
          let totalBytes = 0
          const dir = await mkdtemp(join(tmpdir(), 'sa-inventory-'))
          try {
            const files: string[] = []
            for (const [index, key] of selected.entries()) {
              const response = await send<{
                Body?: { transformToByteArray(): Promise<Uint8Array> }
              }>(new GetObjectCommand({ Bucket: destinationBucket, Key: key }))
              const bytes = (await response.Body?.transformToByteArray()) ?? new Uint8Array()
              totalBytes += bytes.length
              if (bytes.length > 128 * 1024 * 1024 || totalBytes > 512 * 1024 * 1024) {
                truncated = true
                break
              }
              const local = join(dir, `${index}-${basename(key) || 'inventory'}`)
              await writeFile(local, bytes)
              files.push(local)
            }
            const id = createHash('sha1')
              .update(
                `${ctx.conversationId}:${bucket}:${manifest.creationTimestamp ?? ''}:${selected.length}`,
              )
              .digest('hex')
              .slice(0, 16)
            const datasetPath = join(deps.datasetsDir(ctx.conversationId), `${id}.sqlite`)
            const imported = await importInventoryFiles({
              files,
              destPath: datasetPath,
              fallbackBucket: bucket,
            })
            const datasetKey = `inventory:${bucket}`
            ctx.datasets.set(datasetKey, {
              kind: 'inventory',
              path: datasetPath,
              rows: imported.rows,
            })
            await deps.db.insertDataset({
              id,
              conversation_id: ctx.conversationId,
              kind: 'inventory',
              path: datasetPath,
              rows: imported.rows,
              bytes: datasetBytes(datasetPath),
            })
            return {
              file: datasetKey,
              rows: imported.rows,
              format,
              manifestAt: manifest.creationTimestamp ?? null,
              truncated: truncated || imported.truncated || listingTruncated,
              columns: imported.columns,
              note: `${files.length} inventory file(s), ${imported.rows} row(s) imported from ${manifest.creationTimestamp ?? 'the latest manifest'}.${truncated || imported.truncated || listingTruncated ? ' Coverage is partial.' : ''} Use aggregate({file: '${datasetKey}', ...}).`,
            }
          } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined)
          }
        }
        if (format === 'CSV' && fileSize(file) > 32 * 1024 * 1024)
          return {
            rows: [],
            format,
            manifestAt: manifest.creationTimestamp ?? null,
            truncated: false,
            note: 'The first CSV inventory file is larger than 32 MiB; open it in the analysis tool instead.',
          }
        if (format === 'PARQUET' && fileSize(file) > 16 * 1024 * 1024)
          return {
            rows: [],
            format,
            manifestAt: manifest.creationTimestamp ?? null,
            truncated: false,
            note: 'The first Parquet inventory file is larger than 16 MiB; open it in the analysis tool instead.',
          }
        const dataResponse = await send<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>(
          new GetObjectCommand({
            Bucket: destinationBucket,
            Key: file,
            ...(format === 'PARQUET' || fileSize(file) > 8 * 1024 * 1024
              ? {}
              : { Range: 'bytes=0-8388607' }),
          }),
        )
        let bytes = (await dataResponse.Body?.transformToByteArray()) ?? new Uint8Array()
        let rows: Record<string, unknown>[] = []
        if (format === 'PARQUET') {
          try {
            const fileBuffer = {
              byteLength: bytes.length,
              slice: async (start: number, end: number) =>
                bytes.buffer.slice(start, end) as ArrayBuffer,
            }
            const parsed = (await parquetReadObjects({ file: fileBuffer })) as Record<
              string,
              unknown
            >[]
            rows = parsed.slice(0, maxRows)
          } catch {
            return {
              rows: [],
              format,
              manifestAt: manifest.creationTimestamp ?? null,
              truncated: false,
              note: 'The Parquet inventory file could not be parsed.',
            }
          }
        } else {
          if (file.endsWith('.gz') || (bytes[0] === 0x1f && bytes[1] === 0x8b))
            bytes = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 })
          const text = Buffer.from(bytes).toString('utf8').slice(0, 2_000_000)
          try {
            rows = parseCsv(text, {
              columns: true,
              bom: true,
              skip_empty_lines: true,
              relax_column_count: true,
            }) as Record<string, string>[]
          } catch {
            return {
              rows: [],
              format,
              manifestAt: manifest.creationTimestamp ?? null,
              truncated: false,
              note: 'The inventory CSV could not be parsed.',
            }
          }
        }
        const normalized = rows.slice(0, maxRows).map((row) => {
          const key = String(row.key ?? row.Key ?? '')
          return {
            bucket: String(row.bucket ?? manifest.sourceBucket ?? bucket),
            key,
            prefix: key.includes('/') ? `${key.split('/')[0]}/` : '(root)',
            size: Number(row.size ?? row.object_size ?? 0),
            storage_class: String(row.storage_class ?? row.storageClass ?? ''),
            last_modified: String(row.last_modified_date ?? row.lastModified ?? ''),
          }
        })
        return {
          rows: normalized,
          format,
          manifestAt: manifest.creationTimestamp ?? null,
          truncated:
            rows.length > maxRows ||
            Boolean(manifest.files && manifest.files.length > 1) ||
            listingTruncated,
          note: `${rows.length} row(s) read from ${file}; inventory covers objects not listed by ListObjects.${
            fileSize(file) > bytes.length ? ' Only the first part of the file was read.' : ''
          }`,
        }
      },
    },
    {
      name: 'principal',
      description:
        'Who can reach a bucket (effective access), or — when no bucket is named — which remembered buckets a principal apparently reaches. Conditions and unread sources are reported, never treated as clean.',
      execute: async (args) => {
        const a = args as { bucket?: unknown; principal?: unknown; limit?: unknown }
        const wanted = String(a.principal ?? '')
          .trim()
          .toLowerCase()
        // Access paths redact the account id; match the same shape so a full
        // ARN argument still finds a policy path that names it.
        const needle = wanted.replace(/\b\d{12}\b/g, '<account>')
        const limit = Math.max(1, Math.min(Number(a.limit ?? 10) || 10, 20))
        const session: AccessSession = {}
        const readOne = async (bucket: string) => {
          const name = bucketArg({ bucket })
          spend()
          const facts = await readBucket(client, name, {
            aspects: new Set(['security']),
            signal: ctx.signal,
            regional: ctx.regional,
            defaultRegion: config.region,
            aws,
            account: (await ctx.account?.()) ?? UNREAD_ACCOUNT,
          })
          const before = session.calls ?? 0
          const access = await readAccess({
            bucket: name,
            facts,
            aws,
            iam: aws && config.caps.iam ? deps.providers.iam(config) : undefined,
            kms:
              aws && config.caps.kms && facts.encryption.value?.keyArn
                ? deps.providers.kms(config, facts.region)
                : undefined,
            analyzer:
              aws && config.caps.accessAnalyzer
                ? deps.providers.accessAnalyzer(config, facts.region)
                : undefined,
            organizations: aws ? deps.providers.organizations(config) : undefined,
            signal: ctx.signal,
            session,
          })
          // The access reader makes many account-wide requests; charge only
          // the delta, because the session totals are cumulative across buckets.
          charge((access.calls ?? 0) - before)
          return {
            bucket: name,
            paths: access.paths.filter(
              (item) =>
                !needle ||
                item.principal.toLowerCase().includes(needle) ||
                item.principal.includes('*') ||
                item.principal === 'AllUsers' ||
                item.public,
            ),
            coverage: access.coverage,
            blind: access.blind,
          }
        }
        if (a.bucket) {
          const result = await readOne(String(a.bucket))
          ctx.usage.coverage = result.coverage
          ctx.usage.blind = result.blind
          return result
        }
        spend()
        const listed = await send<{ Buckets?: { Name?: string }[] }>(new ListBucketsCommand({}))
        const visible = (listed.Buckets ?? []).flatMap((bucket) =>
          bucket.Name &&
          (config.scope.buckets.length === 0 || config.scope.buckets.includes(bucket.Name))
            ? [bucket.Name]
            : [],
        )
        const allRemembered = visible.length
          ? visible
          : (await deps.db.listBuckets(config.id))
              .map((row) => row.name)
              .filter(
                (bucket) =>
                  config.scope.buckets.length === 0 || config.scope.buckets.includes(bucket),
              )
        const remembered = allRemembered.slice(0, limit)
        const results = []
        for (const bucket of remembered) results.push(await readOne(bucket))
        const coverage = {
          principals: results.reduce((n, item) => n + item.coverage.principals, 0),
          evaluated: results.reduce((n, item) => n + item.coverage.evaluated, 0),
          undecided: results.reduce((n, item) => n + item.coverage.undecided, 0),
          truncated:
            remembered.length < allRemembered.length ||
            results.some((item) => item.coverage.truncated),
          sources: [...new Set(results.flatMap((item) => item.coverage.sources))],
          bucketsExamined: remembered.length,
          bucketsTotal: allRemembered.length,
        }
        ctx.usage.coverage = coverage
        ctx.usage.blind = [
          ...new Map(
            results.flatMap((item) =>
              item.blind.map((blind) => [`${blind.source}:${blind.status}`, blind]),
            ),
          ).values(),
        ]
        return { buckets: results, coverage }
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
    description: `Answer a question no other tool can by running a short read-only JavaScript script over the account: largest prefixes, data untouched for a year, objects by storage class, versions piling up, buckets by size. Use it when the answer needs many objects or many buckets; use the other tools for one bucket or one object. \`list\` is one bounded page; S3 Inventory reads the latest manifest, or imports every manifest file into a local dataset with its inventory date. Attached logs and inventories import as datasets that answer whitelisted aggregates. A truncated page or import is not exhaustive.\n${QUERY_API}`,
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
      const usage: {
        calls: number
        listed: number
        coverage?: AccessCoverage
        blind?: { source: string; status: string }[]
      } = { calls: 0, listed: 0 }
      const touched = new Set<string>()
      const aws = deps.providers.isAws(config)
      let accountFacts: import('../s3/account').AccountFacts | null = null
      const account = async () => {
        if (!aws) return UNREAD_ACCOUNT
        accountFacts ??= await readAccount(
          deps.providers.sts(config),
          deps.providers.control(config),
          run.signal,
        )
        return accountFacts
      }
      const sandbox = new CodemodeSandbox({
        tools: primitives({
          deps,
          config,
          client,
          signal: run.signal,
          regional: run.regional,
          account,
          usage,
          touched,
          conversationId: run.conversationId,
          datasets: new Map(),
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
        ...table.rows.map((row) => row.map((v) => (v === null ? '' : String(v))).join('\t')),
      ].join('\n')
      const lines = [
        `${args.title}: ${table.rows.length}${table.truncated ? '+' : ''} row(s) from ${usage.calls} read-only call(s) over ${usage.listed.toLocaleString('en-US')} listed item(s).`,
        table.rows.length ? preview : 'The script returned no rows.',
        ...(output ? [`Output:\n${output}`] : []),
      ]
      return {
        model: lines.join('\n'),
        note: `${table.rows.length} row${table.rows.length === 1 ? '' : 's'} · ${usage.calls} call${usage.calls === 1 ? '' : 's'}`,
        view: {
          kind: 'query' as const,
          providerId: config.id,
          title: args.title.slice(0, 120),
          code: args.code.slice(0, QUERY_BUDGET.codeChars),
          rows: table,
          chart,
          output: output || null,
          calls: usage.calls,
          listed: usage.listed,
          buckets: [...touched].slice(0, 200),
          ...(usage.coverage ? { coverage: usage.coverage } : {}),
          ...(usage.blind?.length ? { blind: usage.blind } : {}),
        },
      }
    },
  })
}
