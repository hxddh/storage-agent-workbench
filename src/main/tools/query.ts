/**
 * Read-only code mode.
 *
 * Some questions span more objects or buckets than one call can carry to the
 * model — the largest prefixes of a bucket, data untouched for a year, buckets
 * by storage class. The model writes a script; it runs in a QuickJS sandbox
 * (no fetch, no require, no process, no timers) whose only capabilities are the
 * primitives below: any read the `call` tool can make, what the task holds
 * (results, bodies, attachments), earlier tasks, and local read-only datasets
 * with every column of the files, objects or inventory they came from. The
 * script's returned value reaches the model and the page.
 */
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline } from 'node:stream/promises'
import { CodemodeSandbox, type CodemodeTool } from '@earendil-works/pi-codemode'
import type { Chart, Table } from '@shared/contract'
import { checkViewDoc, viewDoc, viewText } from '@shared/view'
import {
  columnsOf,
  type DatasetFormat,
  datasetBytes,
  FORMATS,
  type ImportOptions,
  type ImportSource,
  importDataset,
} from '../analysis/import'
import type { ProviderConfig } from '../providers'
import { type CallInput, callApi, operationShape, operationsOf, SERVICES, scrub } from '../s3/api'
import { redact, redactView } from '../security/redact'
import { assertInScope } from '../security/scope'
import { checkSql } from '../sql'
import { locate, readPart } from './more'
import { agentTool, providerParam, type ToolDeps, Type } from './policy'

/**
 * What the sandbox may take of this machine unless the script asks for more.
 * These protect the user's computer, not the storage or the agent's reach.
 */
export const SANDBOX = { memoryMb: 1024, viewRows: 10_000 }

/** The primitives as the model sees them, in the tool description. */
export const QUERY_API = `Primitives (all read-only, all async):
  call({service, operation, input?, region?, maxBytes?}): the service's response   // any read the call tool makes, same rules; an object Body comes back whole up to maxBytes (default 1 MiB) as {text|base64, bytesRead, ref, more?}
  read({name, offset?, length?}): {text|base64, start, end, total}   // any stretch of what this task holds: a call's evidence id, an object ref (objects/…) or attachment:<file>
  dataset({file? | ref? | bucket+key? | bucket+prefix?, name?, format?, columns?, header?}): {name, format, rows, columns}   // import an attachment, an object body, one object or every object under a prefix into a local SQLite table "rows" with every source column (format: ${FORMATS.join('|')}, detected when omitted; columns names a header-less CSV); _source says where a row came from
  inventory({bucket, name?}): {name, rows, columns, manifestAt, files}   // import the bucket's latest S3 Inventory report with its own schema
  sql({name, sql, params?}): row[]   // one read-only SELECT (or WITH … SELECT) over a dataset's "rows" table; datasets imported in earlier scripts of this task are found by name
  datasets(): {name, format, source, rows, columns}[]   // the datasets this task holds
  history({query?, task?}): matching messages and answers from every task, or one task's whole conversation   // what earlier work found
  discover({kind?: "aws"|"tools", service?, operation?}): services, read operations with their input and output members, tools
  memory({action, ...}): read or write durable JSON memory (put, get, list, search, query, delete)
  render({title?, doc}): return a ViewDoc for the window to render
Call them as tools.call({...}) etc. Return rows (an array of objects) for a table, {rows, chart: {label, value}} for a bar chart, a ViewDoc, or any JSON value. text("…") adds a line of output.`

/** Whether a script returned rows (objects in an array, or exactly {rows, chart?}) rather than another value. */
export function isRows(value: unknown): boolean {
  const rows = Array.isArray(value)
    ? value
    : value &&
        typeof value === 'object' &&
        Array.isArray((value as { rows?: unknown }).rows) &&
        Object.keys(value).every((key) => key === 'rows' || key === 'chart')
      ? (value as { rows: unknown[] }).rows
      : null
  return (
    rows?.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row)) ?? false
  )
}

function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return redact(scrub(value) as string)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return redact(JSON.stringify(scrub(value)))
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
export interface SandboxContext {
  /** The task's conversation; a delegated child uses its task's. */
  conversationId: string
  deps: ToolDeps
  config: ProviderConfig
  signal: AbortSignal
  calls: { count: number }
  touched: Set<string>
  datasets: Map<string, { format: string; path: string; rows: number }>
}

/** A dataset by the name a script gave it, in this script or an earlier one of the task. */
async function datasetNamed(ctx: SandboxContext, name: string) {
  const here = ctx.datasets.get(name)
  if (here) return here
  const known = await ctx.deps.db.datasetByName(ctx.conversationId, name)
  if (!known || !existsSync(known.path)) return null
  const found = { format: known.format, path: known.path, rows: known.rows }
  ctx.datasets.set(name, found)
  return found
}

export function sandboxPrimitives(ctx: SandboxContext): CodemodeTool[] {
  const { deps, config } = ctx
  const call = (input: CallInput) => {
    ctx.calls.count += 1
    const bucket = (input.input as { Bucket?: unknown } | undefined)?.Bucket
    if (typeof bucket === 'string') ctx.touched.add(bucket)
    return callApi(
      {
        providers: deps.providers,
        config,
        signal: ctx.signal,
        bodyDir: deps.taskDir(ctx.conversationId),
      },
      input,
    )
  }
  const register = async (
    name: string,
    source: string,
    path: string,
    result: { format: string; rows: number; columns: string[] },
  ) => {
    ctx.datasets.set(name, { format: result.format, path, rows: result.rows })
    await deps.db.upsertDataset({
      id: basename(path, '.sqlite'),
      conversation_id: ctx.conversationId,
      name,
      format: result.format,
      source,
      path,
      rows: result.rows,
      bytes: datasetBytes(path),
    })
    return { name, format: result.format, rows: result.rows, columns: result.columns }
  }
  const datasetPath = () => join(deps.datasetsDir(ctx.conversationId), `${randomUUID()}.sqlite`)
  /** One object streamed to a local file; nothing holds it whole in memory. */
  const download = async (bucket: string, key: string, dir: string, index: number) => {
    ctx.calls.count += 1
    const client = deps.providers.client(config)
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: ctx.signal,
    })
    const local = join(dir, `${index}-${basename(key) || 'object'}`)
    await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(local))
    return local
  }
  const importOptions = (a: Record<string, unknown>): ImportOptions => ({
    ...(typeof a.format === 'string' && (FORMATS as readonly string[]).includes(a.format)
      ? { format: a.format as DatasetFormat }
      : {}),
    ...(Array.isArray(a.columns) ? { columns: a.columns.map((c) => String(c)) } : {}),
    ...(typeof a.header === 'boolean' ? { header: a.header } : {}),
  })

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
          // A script holds the body it read, not a preview of it.
          inlineBody: true,
        })
      },
    },
    {
      name: 'read',
      description: "Any stretch of a call's kept result, an object body or an attached file.",
      execute: async (args) => {
        const a = (args ?? {}) as { name?: unknown; offset?: unknown; length?: unknown }
        const part = await readPart(
          deps,
          ctx.conversationId,
          String(a.name ?? ''),
          typeof a.offset === 'number' ? Math.max(0, a.offset) : 0,
          typeof a.length === 'number' && a.length > 0 ? a.length : Number.MAX_SAFE_INTEGER,
        )
        return {
          ...(part.base64 !== undefined ? { base64: part.base64 } : { text: part.text }),
          start: part.start,
          end: part.end,
          total: part.total,
          unit: part.unit,
        }
      },
    },
    {
      name: 'discover',
      description: 'The environment capability graph: AWS reads or the tools available here.',
      execute: async (args) => {
        const a = (args ?? {}) as { kind?: unknown; service?: unknown; operation?: unknown }
        if (a.kind === 'tools') {
          const saved = await deps.db.listAgentTools(ctx.conversationId)
          return {
            tools: [
              ...(deps.catalog ?? []).map((tool) => tool.name),
              ...saved.map((row) => row.name),
            ],
          }
        }
        const service = typeof a.service === 'string' ? a.service.toLowerCase() : ''
        if (!service) return { services: SERVICES }
        if (!SERVICES.includes(service))
          throw new Error(
            `Service '${service}' is not available. Available: ${SERVICES.join(', ')}.`,
          )
        const operations = operationsOf(service)
        if (typeof a.operation !== 'string') return { service, operations }
        if (!operations.includes(a.operation))
          throw new Error(`${service} has no read operation '${a.operation}'.`)
        return { service, operation: a.operation, ...operationShape(service, a.operation) }
      },
    },
    {
      name: 'memory',
      description: 'Read or write durable JSON memory.',
      execute: async (args) => {
        const a = (args ?? {}) as Record<string, unknown>
        const memory = deps.memory
        if (!memory) throw new Error('Memory is not available in this build.')
        const scope = a.scope === 'task' ? 'task' : 'user'
        const conversationId = scope === 'task' ? ctx.conversationId : null
        if (a.action === 'put') {
          const key = String(a.key ?? '')
          if (!key) throw new Error('memory put needs a key.')
          return memory.put({
            key,
            value: redactView(a.value ?? null),
            ...(typeof a.text === 'string' ? { text: redact(a.text) } : {}),
            ...(Array.isArray(a.tags)
              ? {
                  tags: a.tags
                    .filter((tag): tag is string => typeof tag === 'string')
                    .map((tag) => redact(tag)),
                }
              : {}),
            scope,
            conversationId,
            origin: ctx.conversationId,
          })
        }
        if (a.action === 'get') {
          const key = String(a.key ?? '')
          const doc = memory.get(key, scope, conversationId)
          if (!doc) throw new Error(`No memory document '${key}'.`)
          return doc
        }
        if (a.action === 'list')
          return memory.list({
            ...(a.scope ? { scope, conversationId } : {}),
            ...(typeof a.prefix === 'string' ? { prefix: a.prefix } : {}),
            ...(typeof a.tag === 'string' ? { tag: a.tag } : {}),
          })
        if (a.action === 'search') return memory.search(String(a.query ?? ''))
        if (a.action === 'query')
          return memory.query(
            String(a.sql ?? ''),
            Array.isArray(a.params) ? (a.params as (string | number | null)[]) : [],
          )
        if (a.action === 'delete') {
          if (typeof a.id === 'string') {
            memory.delete(a.id)
            return { deleted: a.id }
          }
          const key = String(a.key ?? '')
          if (!key) throw new Error('memory delete needs a key or id.')
          memory.deleteByKey(key, scope, conversationId)
          return { deleted: key }
        }
        throw new Error(`Unknown memory action '${String(a.action)}'.`)
      },
    },
    {
      name: 'render',
      description: 'Return a validated ViewDoc for the window.',
      execute: async (args) => {
        const a = (args ?? {}) as { title?: unknown; doc?: unknown }
        const checked = checkViewDoc(a.doc)
        if (!checked.doc) throw new Error(`render: ${checked.errors.join('; ')}`)
        return checked.doc
      },
    },
    {
      name: 'history',
      description: 'Messages and answers of earlier tasks.',
      execute: async (args) => {
        const a = (args ?? {}) as { query?: unknown; task?: unknown }
        const titles = new Map(
          (await deps.db.listTaskMeta()).map((task) => [task.conversation_id, task.title]),
        )
        if (typeof a.task === 'string' && a.task) {
          const docs = await deps.db.taskDocs(a.task)
          return {
            task: a.task,
            title: titles.get(a.task) ?? null,
            messages: docs.map((doc) => ({ kind: doc.kind, at: doc.at, text: doc.text })),
          }
        }
        const query = String(a.query ?? '').trim()
        if (!query) return [...titles].map(([task, title]) => ({ task, title }))
        return (await deps.db.searchDocs(query)).map((doc) => ({
          task: doc.conversation_id,
          title: titles.get(doc.conversation_id) ?? null,
          kind: doc.kind,
          at: doc.at,
          text: doc.text,
        }))
      },
    },
    {
      name: 'datasets',
      description: 'The datasets this task holds.',
      execute: async () =>
        (await deps.db.listDatasets(ctx.conversationId))
          .filter((row) => existsSync(row.path))
          .map((row) => ({
            name: row.name,
            format: row.format,
            source: row.source,
            rows: row.rows,
            columns: columnsOf(row.path),
          })),
    },
    {
      name: 'dataset',
      description: 'Import a file, object, prefix or body into a local dataset with every column.',
      execute: async (args) => {
        const a = (args ?? {}) as Record<string, unknown>
        const options = importOptions(a)
        const named = typeof a.name === 'string' && a.name ? a.name : null
        // An attached file or an object body this task already read.
        if (typeof a.file === 'string' || typeof a.ref === 'string') {
          const ref =
            typeof a.ref === 'string'
              ? a.ref
              : `attachment:${String(a.file).replace(/^attachment:/, '')}`
          const where = locate(deps, ctx.conversationId, ref)
          if (!existsSync(where.path)) {
            const uploads = deps.uploadsDir(ctx.conversationId)
            const available = existsSync(uploads) ? readdirSync(uploads) : []
            throw new Error(
              `Nothing named "${ref}" in this task.${available.length ? ` Attached: ${available.join(', ')}.` : ''}`,
            )
          }
          const label = ref.replace(/^attachment:/, '')
          const path = datasetPath()
          const result = await importDataset([{ path: where.path, label }], path, options)
          return register(named ?? label, ref, path, result)
        }
        const bucket = typeof a.bucket === 'string' ? a.bucket : ''
        if (!bucket) throw new Error('dataset needs file, ref, or bucket with key or prefix.')
        assertInScope(config, bucket)
        ctx.touched.add(bucket)
        const keys: string[] = []
        if (typeof a.key === 'string' && a.key) keys.push(a.key)
        else {
          const prefix = typeof a.prefix === 'string' ? a.prefix : ''
          let token: string | undefined
          do {
            const page = (await call({
              service: 's3',
              operation: 'ListObjectsV2',
              input: { Bucket: bucket, Prefix: prefix, ContinuationToken: token },
            })) as { Contents?: { Key?: string }[]; NextContinuationToken?: string }
            for (const item of page.Contents ?? [])
              if (item.Key && !item.Key.endsWith('/')) keys.push(item.Key)
            token = page.NextContinuationToken
          } while (token)
          if (!keys.length) throw new Error(`No objects in s3://${bucket}/${prefix}.`)
        }
        const source = `s3://${bucket}/${typeof a.key === 'string' && a.key ? a.key : String(a.prefix ?? '')}`
        const dir = await mkdtemp(join(tmpdir(), 'sa-dataset-'))
        try {
          const files: ImportSource[] = []
          for (const [index, key] of keys.entries())
            files.push({
              path: await download(bucket, key, dir, index),
              label: `s3://${bucket}/${key}`,
            })
          const path = datasetPath()
          const result = await importDataset(files, path, options)
          return register(named ?? source, source, path, result)
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        }
      },
    },
    {
      name: 'inventory',
      description:
        "Import every file of a bucket's latest S3 Inventory manifest into a local dataset.",
      execute: async (args) => {
        const a = (args ?? {}) as { bucket?: unknown; name?: unknown }
        const bucket = String(a.bucket ?? '')
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
        const latest = manifests.sort((x, y) =>
          String(y.LastModified ?? '').localeCompare(String(x.LastModified ?? '')),
        )[0]
        if (!latest) throw new Error(`The inventory of ${bucket} has no manifest yet.`)
        const manifestBody = (await call({
          service: 's3',
          operation: 'GetObject',
          input: { Bucket: target, Key: latest.Key },
          maxBytes: Number.MAX_SAFE_INTEGER,
          inlineBody: true,
        })) as { Body?: { text?: string } }
        const manifest = JSON.parse(manifestBody.Body?.text ?? '{}') as {
          creationTimestamp?: string
          fileFormat?: string
          fileSchema?: string
          files?: { key: string }[]
        }
        const keys = (manifest.files ?? []).map((item) => item.key).filter(Boolean)
        // The report's own schema: CSV files carry no header, the manifest names the columns.
        const format: DatasetFormat = /parquet/i.test(manifest.fileFormat ?? '') ? 'parquet' : 'csv'
        const columns =
          format === 'csv' && manifest.fileSchema
            ? manifest.fileSchema.split(',').map((column) => column.trim())
            : undefined
        const name = typeof a.name === 'string' && a.name ? a.name : `inventory:${bucket}`
        const dir = await mkdtemp(join(tmpdir(), 'sa-inventory-'))
        try {
          const files: ImportSource[] = []
          for (const [index, key] of keys.entries())
            files.push({
              path: await download(target, key, dir, index),
              label: `s3://${target}/${key}`,
            })
          const path = datasetPath()
          const result = await importDataset(files, path, {
            format,
            ...(columns ? { columns, header: false } : {}),
          })
          const registered = await register(name, `inventory:${bucket}`, path, result)
          return {
            ...registered,
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
      description: 'One read-only SELECT over a dataset of this task.',
      execute: async (args) => {
        const a = (args ?? {}) as {
          name?: unknown
          file?: unknown
          sql?: unknown
          params?: unknown
        }
        const name = String(a.name ?? a.file ?? '')
        const dataset = await datasetNamed(ctx, name)
        if (!dataset)
          throw new Error(
            `No dataset named '${name}' in this task. Import one with dataset() or inventory(); datasets() lists them.`,
          )
        const sql = String(a.sql ?? '')
        checkSql(sql)
        const db = new DatabaseSync(dataset.path, { readOnly: true })
        try {
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
        tools: sandboxPrimitives({
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
      const rendered = viewDoc(result.value)
      if (rendered)
        return {
          model: viewText(rendered),
          note: `${rendered.blocks.length} view block(s)`,
          view: {
            kind: 'render' as const,
            title: args.title ?? 'View',
            doc: rendered,
          },
        }
      // Rows are a table; any other value reaches the model as the JSON it is.
      if (!isRows(result.value)) {
        const value = scrub(result.value ?? null)
        return {
          model: [
            `${args.title ? `${args.title}: ` : ''}value from ${calls.count} read-only call(s).`,
            JSON.stringify(value, null, 1),
            ...(output ? [`Output:\n${output}`] : []),
          ].join('\n'),
          note: `${calls.count} call${calls.count === 1 ? '' : 's'}`,
          view: { kind: 'raw' as const, title: args.title ?? 'Query result', value },
        }
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
