/**
 * Read-only code mode.
 *
 * Some questions span more objects or buckets than one call can carry to the
 * model — the largest prefixes of a bucket, data untouched for a year, buckets
 * by storage class. The model writes a script; it runs in a QuickJS sandbox
 * (no fetch, no require, no process, no timers) whose only capabilities are the
 * primitives below: any read the `call` tool can make, and local read-only
 * datasets built from attached files or S3 Inventory. The script's returned
 * rows reach the model and the page.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline } from 'node:stream/promises'
import { CodemodeSandbox, type CodemodeTool } from '@earendil-works/pi-codemode'
import type { Chart, Table } from '@shared/contract'
import { type DatasetKind, preview, TABLES } from '../analysis/dataset'
import { datasetBytes, importDataset, importInventoryFiles } from '../analysis/import'
import type { ProviderConfig } from '../providers'
import { type CallInput, callApi } from '../s3/api'
import { redact } from '../security/redact'
import { assertInScope } from '../security/scope'
import { agentTool, providerParam, type ToolDeps, Type } from './policy'

/**
 * What the sandbox may take of this machine unless the script asks for more.
 * These protect the user's computer, not the storage or the agent's reach.
 */
export const SANDBOX = { memoryMb: 1024, viewRows: 10_000 }

/** The primitives as the model sees them, in the tool description. */
export const QUERY_API = `Primitives (all read-only, all async):
  call({service, operation, input?, region?, maxBytes?}): the service's response   // any read the call tool makes, with the same rules
  dataset({file, kind?: "access_log"|"inventory"}): {file, kind, rows, columns}   // import one attached access log or inventory into a local SQLite table named "rows"
  inventory({bucket}): {file, rows, columns, manifestAt}   // import every file of the bucket's latest S3 Inventory manifest into a local dataset
  sql({file, sql, params?}): row[]   // one read-only SELECT (or WITH … SELECT) over a dataset's "rows" table
Call them as tools.call({...}) etc. Return an array of flat rows (objects with string/number/boolean values), or {rows, chart: {label: "<column>", value: "<numeric column>"}}. text("…") adds a line of output.`

function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
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
  for (const row of objects)
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  const table: Table = {
    columns,
    rows: objects.map((row) => columns.map((column) => cell(row[column]))),
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

/**
 * One statement that starts by reading. The dataset opens read-only, so a write
 * cannot happen whatever the text says; this keeps a script to one query.
 */
export function checkSql(sql: string): void {
  const text = sql.trim().replace(/;\s*$/, '')
  if (!/^(select|with)\b/i.test(text)) throw new Error('sql must be one SELECT (or WITH … SELECT).')
  if (text.includes(';')) throw new Error('sql must be one statement.')
  if (/\bload_extension\b/i.test(text)) throw new Error('sql may not load extensions.')
}

interface Context {
  conversationId: string
  deps: ToolDeps
  config: ProviderConfig
  signal: AbortSignal
  calls: { count: number }
  touched: Set<string>
  datasets: Map<string, { kind: DatasetKind; path: string; rows: number }>
}

/** The datasets of this task, by the name a script imported them under. */
async function knownDatasets(ctx: Context) {
  const rows = await ctx.deps.db.listDatasets(ctx.conversationId)
  return rows
}

function primitives(ctx: Context): CodemodeTool[] {
  const { deps, config } = ctx
  const call = (input: CallInput) => {
    ctx.calls.count += 1
    const bucket = (input.input as { Bucket?: unknown } | undefined)?.Bucket
    if (typeof bucket === 'string') ctx.touched.add(bucket)
    return callApi({ providers: deps.providers, config, signal: ctx.signal }, input)
  }
  const register = async (
    name: string,
    id: string,
    path: string,
    kind: DatasetKind,
    rows: number,
  ) => {
    ctx.datasets.set(name, { kind, path, rows })
    await deps.db.insertDataset({
      id,
      conversation_id: ctx.conversationId,
      kind,
      path,
      rows,
      bytes: datasetBytes(path),
    })
  }

  return [
    {
      name: 'call',
      description: 'Any read the call tool makes, as the service answers it.',
      execute: async (args) => {
        const a = (args ?? {}) as Record<string, unknown>
        return call({
          service: String(a.service ?? ''),
          operation: String(a.operation ?? ''),
          input: (a.input ?? {}) as Record<string, unknown>,
          ...(typeof a.region === 'string' ? { region: a.region } : {}),
          ...(typeof a.maxBytes === 'number' ? { maxBytes: a.maxBytes } : {}),
        })
      },
    },
    {
      name: 'dataset',
      description: 'Import one attached access log or object inventory into a local dataset.',
      execute: async (args) => {
        const file = String((args as { file?: unknown })?.file ?? '')
        if (!file) throw new Error('file is required.')
        if (!/^[^/\\]{1,200}$/.test(file)) throw new Error('file must be a plain file name.')
        const uploads = deps.uploadsDir(ctx.conversationId)
        const path = join(uploads, file)
        if (!existsSync(path)) {
          const available = existsSync(uploads) ? readdirSync(uploads) : []
          throw new Error(
            available.length
              ? `No attached file named '${file}'. Attached: ${available.join(', ')}.`
              : 'No files are attached to this task.',
          )
        }
        const stat = statSync(path)
        const id = createHash('sha1')
          .update(`${ctx.conversationId}:${file}:${stat.size}:${stat.mtimeMs}`)
          .digest('hex')
          .slice(0, 16)
        const datasetPath = join(deps.datasetsDir(ctx.conversationId), `${id}.sqlite`)
        if (existsSync(datasetPath)) {
          const known = (await knownDatasets(ctx)).find((row) => row.id === id)
          const kind = (known?.kind as DatasetKind) ?? 'access_log'
          ctx.datasets.set(file, { kind, path: datasetPath, rows: known?.rows ?? 0 })
          return {
            file,
            kind,
            rows: known?.rows ?? 0,
            columns: preview(datasetPath, kind, 1).columns,
          }
        }
        const requested = (args as { kind?: unknown })?.kind
        await mkdir(deps.datasetsDir(ctx.conversationId), { recursive: true })
        const result = await importDataset({
          filePath: path,
          destPath: datasetPath,
          ...(requested === 'inventory' || requested === 'access_log' ? { kind: requested } : {}),
        })
        await register(file, id, datasetPath, result.kind, result.rows)
        return { file, kind: result.kind, rows: result.rows, columns: result.columns }
      },
    },
    {
      name: 'inventory',
      description:
        "Import every file of a bucket's latest S3 Inventory manifest into a local dataset.",
      execute: async (args) => {
        const bucket = String((args as { bucket?: unknown })?.bucket ?? '')
        if (!bucket) throw new Error('bucket is required.')
        assertInScope(config, bucket)
        ctx.touched.add(bucket)
        const listed = (await call({
          service: 's3',
          operation: 'ListBucketInventoryConfigurations',
          input: { Bucket: bucket },
        })) as {
          InventoryConfigurationList?: {
            IsEnabled?: boolean
            Destination?: { S3BucketDestination?: { Bucket?: string; Prefix?: string } }
          }[]
        }
        const destination = (listed.InventoryConfigurationList ?? []).find((item) => item.IsEnabled)
          ?.Destination?.S3BucketDestination
        const target = destination?.Bucket?.replace(/^arn:aws:s3:::/, '')
        if (!target) throw new Error(`${bucket} has no enabled inventory configuration.`)
        assertInScope(config, target)
        // Every manifest under the destination prefix; the newest one is the inventory.
        const manifests: { Key: string; LastModified?: string }[] = []
        let token: string | undefined
        do {
          const page = (await call({
            service: 's3',
            operation: 'ListObjectsV2',
            input: { Bucket: target, Prefix: destination?.Prefix ?? '', ContinuationToken: token },
          })) as {
            Contents?: { Key?: string; LastModified?: string }[]
            NextContinuationToken?: string
          }
          for (const item of page.Contents ?? [])
            if (item.Key?.endsWith('manifest.json'))
              manifests.push({ Key: item.Key, LastModified: item.LastModified })
          token = page.NextContinuationToken
        } while (token)
        const latest = manifests.sort((a, b) =>
          String(b.LastModified ?? '').localeCompare(String(a.LastModified ?? '')),
        )[0]
        if (!latest) throw new Error(`The inventory of ${bucket} has no manifest yet.`)
        const manifestBody = (await call({
          service: 's3',
          operation: 'GetObject',
          input: { Bucket: target, Key: latest.Key },
          maxBytes: Number.MAX_SAFE_INTEGER,
        })) as { Body?: { text?: string } }
        const manifest = JSON.parse(manifestBody.Body?.text ?? '{}') as {
          creationTimestamp?: string
          files?: { key: string }[]
        }
        const keys = (manifest.files ?? []).map((item) => item.key).filter(Boolean)
        const id = createHash('sha1')
          .update(`${ctx.conversationId}:${bucket}:${manifest.creationTimestamp ?? latest.Key}`)
          .digest('hex')
          .slice(0, 16)
        const datasetPath = join(deps.datasetsDir(ctx.conversationId), `${id}.sqlite`)
        const name = `inventory:${bucket}`
        const dir = await mkdtemp(join(tmpdir(), 'sa-inventory-'))
        try {
          const files: string[] = []
          // Each inventory file streams to disk; nothing holds a whole file in memory.
          const client = deps.providers.client(config)
          const { GetObjectCommand } = await import('@aws-sdk/client-s3')
          for (const [index, key] of keys.entries()) {
            ctx.calls.count += 1
            const response = await client.send(new GetObjectCommand({ Bucket: target, Key: key }), {
              abortSignal: ctx.signal,
            })
            const local = join(dir, `${index}-${basename(key) || 'inventory'}`)
            await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(local))
            files.push(local)
          }
          await mkdir(deps.datasetsDir(ctx.conversationId), { recursive: true })
          const imported = await importInventoryFiles({
            files,
            destPath: datasetPath,
            fallbackBucket: bucket,
          })
          await register(name, id, datasetPath, 'inventory', imported.rows)
          return {
            file: name,
            rows: imported.rows,
            columns: imported.columns,
            manifestAt: manifest.creationTimestamp ?? null,
            files: files.length,
          }
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        }
      },
    },
    {
      name: 'sql',
      description: 'One read-only SELECT over a dataset imported in this task.',
      execute: async (args) => {
        const a = (args ?? {}) as { file?: unknown; sql?: unknown; params?: unknown }
        const file = String(a.file ?? '')
        const dataset = ctx.datasets.get(file)
        if (!dataset) throw new Error(`Import '${file}' with dataset() or inventory() first.`)
        const sql = String(a.sql ?? '')
        checkSql(sql)
        const db = new DatabaseSync(dataset.path, { readOnly: true })
        try {
          // The dataset's table is "rows" whatever its kind called it on import.
          const table = TABLES[dataset.kind]
          db.exec(`CREATE TEMP VIEW IF NOT EXISTS rows AS SELECT * FROM ${table}`)
          const params = Array.isArray(a.params) ? (a.params as (string | number | null)[]) : []
          const out = db.prepare(sql).all(...params) as Record<string, unknown>[]
          return out.map((row) =>
            Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)])),
          )
        } finally {
          db.close()
        }
      },
    },
  ]
}

export function queryTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'query',
    description: `Run a read-only JavaScript script over the account when a question spans more than one call carries: every object in a bucket, every bucket, an inventory, an attached log. The script runs in a sandbox with no network, files, process or timers; its only capabilities are these primitives. It runs until it returns or the user stops it.\n${QUERY_API}`,
    parameters: Type.Object({
      provider_id: providerParam,
      title: Type.Optional(Type.String({ description: 'A name for the result.' })),
      code: Type.String({ description: 'The script body; `return` the rows.' }),
      memory_mb: Type.Optional(
        Type.Integer({
          minimum: 16,
          description: `Sandbox memory, default ${SANDBOX.memoryMb} MB; raise it for a script that holds more.`,
        }),
      ),
    }),
    target: (args) => args.title ?? '',
    run: async (args, run) => {
      const { config } = await run.provider(args.provider_id)
      const calls = { count: 0 }
      const touched = new Set<string>()
      const sandbox = new CodemodeSandbox({
        tools: primitives({
          deps,
          config,
          signal: run.signal,
          calls,
          touched,
          conversationId: run.conversationId,
          datasets: new Map(),
        }),
        // Stop is the control: a script runs as long as it takes.
        timeoutMs: 2_147_483_647,
        memoryLimitBytes: (args.memory_mb ?? SANDBOX.memoryMb) * 1024 * 1024,
      })
      const ticker = setInterval(() => run.progress(`${calls.count} calls`), 1000)
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
          result.error.kind === 'aborted'
            ? 'The script was stopped.'
            : `${result.error.name ?? 'Error'}: ${result.error.message}`
        throw new Error(`${reason}${output ? `\nOutput before it failed:\n${output}` : ''}`)
      }
      const { table, chart } = toTable(result.value)
      const text = [
        table.columns.join('\t'),
        ...table.rows.map((row) => row.map((v) => (v === null ? '' : String(v))).join('\t')),
      ].join('\n')
      const lines = [
        `${args.title ? `${args.title}: ` : ''}${table.rows.length} row(s) from ${calls.count} read-only call(s).`,
        table.rows.length ? text : 'The script returned no rows.',
        ...(output ? [`Output:\n${output}`] : []),
      ]
      // The window keeps a page of a very large result; the agent gets all of it.
      const shown =
        table.rows.length > SANDBOX.viewRows
          ? { ...table, rows: table.rows.slice(0, SANDBOX.viewRows), truncated: true }
          : table
      return {
        model: lines.join('\n'),
        note: `${table.rows.length} row${table.rows.length === 1 ? '' : 's'} · ${calls.count} call${calls.count === 1 ? '' : 's'}`,
        view: {
          kind: 'query' as const,
          providerId: config.id,
          title: args.title ?? 'Query result',
          code: args.code,
          rows: shown,
          chart,
          output: output || null,
          calls: calls.count,
          buckets: [...touched],
        },
      }
    },
  })
}
