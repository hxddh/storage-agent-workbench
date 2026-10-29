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
import type { Chart, Table } from '@shared/contract'
import { parse as parseCsv } from 'csv-parse/sync'
import { parquetReadObjects } from 'hyparquet'
import {
  AggregationError,
  aggregate,
  type DatasetKind,
  preview,
  readRows,
} from '../analysis/aggregate'
import { datasetBytes, importDataset, importInventoryFiles } from '../analysis/import'
import type { ProviderConfig } from '../providers'
import { readConfig, SECTIONS, type Section } from '../s3/raw'
import { redact } from '../security/redact'
import { readAccountLevel } from './account'
import { agentTool, assertInScope, providerParam, type ToolDeps, Type } from './policy'

export const QUERY_BUDGET = {
  calls: 2000,
  listed: 500_000,
  timeoutMs: 120_000,
  memoryBytes: 256 * 1024 * 1024,
  rows: 500,
}

/** The primitives as the model sees them, in the tool description. */
export const QUERY_API = `Primitives (all read-only, all async, all scoped to the account):
  buckets(): {name, region, created}[]   // region as ListBuckets returns it (null when the provider does not)
  list({bucket, prefix?, delimiter?, kind?: "objects"|"versions"|"uploads", token?, max?}): {items: {key, size, modified, storageClass, versionId?, latest?, deleteMarker?}[], prefixes: string[], next: string|null}   // max ≤ 1000 per page
  head({bucket, key}): {size, contentType, modified, storageClass, encryption, versionId, metadataKeys}
  config({bucket, sections?}): {region, <section>: {status, value?, error?}}   // the bucket's configuration as S3 returns it; sections as the config tool takes them
  account({read, bucket?, key?, days?, token?, region?}): {status, value?, error?}   // the account tool's reads (public_access_block, iam, scps, kms_key_policy, access_analyzer, storage_metrics, cloudtrail); AWS only
  inventory({bucket, maxRows?, full?}): {file, rows, format, manifestAt, truncated, note}   // one manifest page, or full?: import every manifest file into a local dataset for aggregate()
  dataset({file, kind?}): {file, kind, rows, columns}   // import one attached access log or inventory
  aggregate({file, metric, groupBy?, filters?, limit?}): {rows, truncated}   // limit ≤ 1000 groups
  rows({file, filters?, limit?, offset?}): {columns, rows, next}   // one page (≤ 1000) of the dataset's rows, redacted; next is the offset of the following page
Call them as tools.list({...}) etc. An attached file is read by importing it with dataset, then aggregate or rows; there is no SQL. Return an array of flat rows (objects with string/number/boolean values), or {rows, chart: {label: "<column>", value: "<numeric column>"}}. text("…") adds a line of output.
Budget per script: ${QUERY_BUDGET.calls} calls, ${QUERY_BUDGET.listed.toLocaleString('en-US')} listed items, ${QUERY_BUDGET.timeoutMs / 1000} s.`

class BudgetError extends Error {}

function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return redact(JSON.stringify(value))
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
  usage: {
    calls: number
    listed: number
  }
  /** Buckets the script read, listed with its result. */
  touched: Set<string>
  datasets: Map<string, { kind: DatasetKind; path: string; rows: number }>
}

function primitives(ctx: Context): CodemodeTool[] {
  const { deps, config, client } = ctx
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
        const response = await send<{
          Buckets?: { Name?: string; BucketRegion?: string; CreationDate?: Date }[]
        }>(new ListBucketsCommand({}))
        return (response.Buckets ?? [])
          .filter(
            (b) =>
              b.Name &&
              (config.scope.buckets.length === 0 || config.scope.buckets.includes(b.Name)),
          )
          .map((b) => ({
            name: b.Name,
            region: b.BucketRegion ?? null,
            created: b.CreationDate ? new Date(b.CreationDate).toISOString() : null,
          }))
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
      description: 'One bucket’s configuration, section by section, as S3 returns it.',
      execute: async (args) => {
        const bucket = bucketArg(args)
        const wanted = (args as { sections?: unknown })?.sections
        const sections = (
          Array.isArray(wanted) && wanted.length
            ? wanted.filter((item): item is Section => SECTIONS.includes(item as Section))
            : SECTIONS
        ) as Section[]
        charge(sections.length)
        const read = await readConfig(client, bucket, sections, {
          signal: ctx.signal,
          regional: ctx.regional,
          defaultRegion: config.region || 'us-east-1',
        })
        return { region: read.region, ...read.sections }
      },
    },
    {
      name: 'account',
      description: 'Account-level reads on AWS, as the APIs return them.',
      execute: async (args) => {
        const a = (args ?? {}) as Record<string, unknown>
        if (typeof a.bucket === 'string' && a.bucket) bucketArg(a)
        spend()
        return readAccountLevel(deps, config, {
          read: String(a.read ?? '') as never,
          bucket: typeof a.bucket === 'string' ? a.bucket : undefined,
          key: typeof a.key === 'string' ? a.key : undefined,
          days: typeof a.days === 'number' ? a.days : undefined,
          token: typeof a.token === 'string' ? a.token : undefined,
          region: typeof a.region === 'string' ? a.region : undefined,
          signal: ctx.signal,
        })
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
            truncated: result.truncated,
          }
        } catch (error) {
          if (error instanceof AggregationError) throw new Error(error.message)
          throw error
        }
      },
    },
    {
      name: 'rows',
      description: 'One page of an imported dataset’s rows, redacted.',
      execute: async (args) => {
        spend()
        const a = (args ?? {}) as {
          file?: unknown
          filters?: unknown
          limit?: unknown
          offset?: unknown
        }
        const file = String(a.file ?? '')
        const dataset = ctx.datasets.get(file)
        if (!dataset) throw new Error(`Import '${file}' with dataset() first.`)
        const filters =
          a.filters && typeof a.filters === 'object' && !Array.isArray(a.filters)
            ? (a.filters as Record<string, string>)
            : null
        try {
          const page = readRows(dataset.path, dataset.kind, {
            filters,
            limit: Number(a.limit ?? 100),
            offset: Number(a.offset ?? 0),
          })
          return {
            columns: page.columns,
            rows: page.rows.map((row) =>
              Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)])),
            ),
            next: page.next,
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
  ]
}

/** `timeoutMs` is for tests; the app always runs with the full budget. */
export function queryTool(deps: ToolDeps, timeoutMs = QUERY_BUDGET.timeoutMs) {
  return agentTool(deps, {
    name: 'query',
    description: `Answer a question no other tool can by running a short read-only JavaScript script over the account: largest prefixes, data untouched for a year, objects by storage class, versions piling up, buckets by size. \`list\` is one bounded page; S3 Inventory reads the latest manifest, or imports every manifest file into a local dataset with its inventory date. Attached logs and inventories import as datasets that answer whitelisted aggregates and pages of rows.\n${QUERY_API}`,
    parameters: Type.Object({
      provider_id: providerParam,
      title: Type.Optional(Type.String({ description: 'A name for the result.' })),
      code: Type.String({ description: 'The script body; `return` the rows.' }),
    }),
    timeoutMs: timeoutMs + 15_000,
    target: (args) => (args.title ?? '').slice(0, 80),
    run: async (args, run) => {
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
      if (!result.ok) {
        const reason =
          result.error.kind === 'timeout'
            ? `The script ran past ${Math.round(timeoutMs / 1000)} s.`
            : result.error.kind === 'aborted'
              ? 'The script was stopped.'
              : `${result.error.name ?? 'Error'}: ${result.error.message}`
        throw new Error(`${reason}${output ? `\nOutput before it failed:\n${output}` : ''}`)
      }
      const { table, chart } = toTable(result.value)
      const preview = [
        table.columns.join('\t'),
        ...table.rows.map((row) => row.map((v) => (v === null ? '' : String(v))).join('\t')),
      ].join('\n')
      const lines = [
        `${args.title ? `${args.title}: ` : ''}${table.rows.length}${table.truncated ? '+' : ''} row(s) from ${usage.calls} read-only call(s) over ${usage.listed.toLocaleString('en-US')} listed item(s).`,
        table.rows.length ? preview : 'The script returned no rows.',
        ...(output ? [`Output:\n${output}`] : []),
      ]
      return {
        model: lines.join('\n'),
        note: `${table.rows.length} row${table.rows.length === 1 ? '' : 's'} · ${usage.calls} call${usage.calls === 1 ? '' : 's'}`,
        view: {
          kind: 'query' as const,
          providerId: config.id,
          title: (args.title ?? 'Query result').slice(0, 120),
          code: args.code,
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
