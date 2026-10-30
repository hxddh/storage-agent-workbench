/**
 * Local datasets, as the source has them.
 *
 * A file — an attachment, an object body, every object under a prefix, an S3
 * Inventory report — becomes one SQLite table named `rows` with the source's
 * own columns: a CSV's header (or the names the caller gives), a JSON object's
 * keys, a Parquet file's schema, every field of an S3 server access log line.
 * Nothing is dropped, masked or cut; what a column means is the agent's to
 * read. Strings pass through `scrub()` (account ids, credential-shaped text)
 * before they are stored, as every other read does.
 */
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { parse } from 'csv-parse'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { scrub } from '../s3/api'

export type DatasetFormat = 'csv' | 'tsv' | 'jsonl' | 'json' | 'parquet' | 's3_access_log' | 'lines'

export const FORMATS: readonly DatasetFormat[] = [
  'csv',
  'tsv',
  'jsonl',
  'json',
  'parquet',
  's3_access_log',
  'lines',
]

export interface ImportSource {
  /** The local file to read; gzip is read through. */
  path: string
  /** What the `_source` column says for its rows: a file name or an `s3://` URL. */
  label: string
}

export interface ImportOptions {
  /** The format; detected from the first source when not given. */
  format?: DatasetFormat
  /** Column names for a CSV or TSV without a header row (S3 Inventory's `fileSchema`). */
  columns?: string[]
  /** Whether a CSV or TSV starts with a header row; default true unless `columns` is given. */
  header?: boolean
}

export interface ImportResult {
  format: DatasetFormat
  rows: number
  columns: string[]
}

/** The fields of an S3 server access log line, in the order AWS documents them. */
const S3_ACCESS_FIELDS = [
  'bucket_owner',
  'bucket',
  'time',
  'remote_ip',
  'requester',
  'request_id',
  'operation',
  'key',
  'request_uri',
  'http_status',
  'error_code',
  'bytes_sent',
  'object_size',
  'total_time',
  'turn_around_time',
  'referer',
  'user_agent',
  'version_id',
  'host_id',
  'signature_version',
  'cipher_suite',
  'authentication_type',
  'host_header',
  'tls_version',
  'access_point_arn',
  'acl_required',
]

/** A number that reads back as the same text; anything else stays a string. */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

/** Columns whose 12-digit values are quantities, not account ids. */
const QUANTITY = /size|bytes|length|count|time|total|sum|offset|duration|latency/i

/**
 * One value as SQLite stores it. Numbers stay numbers; a numeric string becomes
 * a number when it reads back the same (a 12-digit one only in a column that
 * holds quantities, so an account id is never stored); every other string is
 * scrubbed; an object is its scrubbed JSON.
 */
export function storedValue(column: string, value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint')
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : String(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    if (
      NUMBER.test(value) &&
      value.length <= 15 &&
      (!/^-?\d{12}$/.test(value) || QUANTITY.test(column))
    )
      return Number(value)
    return scrub(value) as string
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return JSON.stringify(scrub(value))
}

/** Read through gzip when the file starts with its magic bytes. */
async function isGzip(path: string): Promise<boolean> {
  const file = await open(path)
  try {
    const head = Buffer.alloc(2)
    await file.read(head, 0, 2, 0)
    return head[0] === 0x1f && head[1] === 0x8b
  } finally {
    await file.close()
  }
}

async function stream(path: string): Promise<Readable> {
  const base = createReadStream(path)
  return (await isGzip(path)) ? base.pipe(createGunzip()) : base
}

async function* lines(path: string): AsyncGenerator<string> {
  const reader = createInterface({ input: await stream(path), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of reader) if (line.trim()) yield line
}

/** The first lines of a file, gzip read through. */
export async function sampleLines(path: string, count = 5): Promise<string[]> {
  const out: string[] = []
  for await (const line of lines(path)) {
    out.push(line)
    if (out.length >= count) break
  }
  return out
}

/** Split an S3 server access log line: quoted and bracketed fields are one field each. */
export function s3AccessFields(line: string): string[] | null {
  const tokens = line.match(/"(?:[^"\\]|\\.)*"|\[[^\]]*\]|\S+/g)
  if (!tokens || tokens.length < 9 || !tokens[2]?.startsWith('[')) return null
  if (!/^[A-Z]+\.[A-Z_.]+/.test(tokens[6] ?? '')) return null
  return tokens.map((token) =>
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith('[') && token.endsWith(']'))
      ? token.slice(1, -1)
      : token,
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `06/Feb/2019:00:00:38 +0000` as an ISO instant; null when it is not one. */
export function logTime(value: string): string | null {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/.exec(value.trim())
  if (!m) return null
  const month = MONTHS.indexOf(m[2]!)
  if (month < 0) return null
  const base = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
  const zone = m[7]
  const offset = zone
    ? (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)))
    : 0
  return new Date(base - offset * 60_000).toISOString().replace(/\.000Z$/, 'Z')
}

/** The format of a file, from its name and first lines. */
export async function detectFormat(path: string, name = path): Promise<DatasetFormat> {
  const lower = name.toLowerCase().replace(/\.gz$/, '')
  if (/\.(parquet|pq)$/.test(lower)) return 'parquet'
  if (/\.(jsonl|ndjson)$/.test(lower)) return 'jsonl'
  if (lower.endsWith('.tsv')) return 'tsv'
  const sample = await sampleLines(path, 2)
  const first = sample[0]?.trim() ?? ''
  if (first.startsWith('{')) return 'jsonl'
  if (first.startsWith('[')) return 'json'
  if (s3AccessFields(first)) return 's3_access_log'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.csv')) return 'csv'
  if (first.includes('\t')) return 'tsv'
  if (first.includes(',')) return 'csv'
  return 'lines'
}

/** One table named `rows` whose columns grow as the source names them. */
class Table {
  readonly columns: string[] = []
  private readonly statements = new Map<string, StatementSync>()

  constructor(private readonly db: DatabaseSync) {
    db.exec('CREATE TABLE rows ("_source" TEXT)')
    this.columns.push('_source')
  }

  /** A source name as a column: never empty, never a duplicate of a different name. */
  private add(name: string): string {
    const clean = name.trim() || `column_${this.columns.length}`
    if (!this.columns.includes(clean)) {
      this.db.exec(`ALTER TABLE rows ADD COLUMN "${clean.replaceAll('"', '""')}"`)
      this.columns.push(clean)
    }
    return clean
  }

  insert(source: string, record: Record<string, unknown>): void {
    const names = Object.keys(record).map((name) => this.add(name))
    const key = names.join('\u0000')
    let stmt = this.statements.get(key)
    if (!stmt) {
      const quoted = ['_source', ...names].map((name) => `"${name.replaceAll('"', '""')}"`)
      stmt = this.db.prepare(
        `INSERT INTO rows (${quoted.join(',')}) VALUES (${quoted.map(() => '?').join(',')})`,
      )
      this.statements.set(key, stmt)
    }
    const values = Object.entries(record).map(([name, value]) => storedValue(name, value))
    stmt.run(source, ...values)
  }
}

/** Header names made unique, so no field of a row overwrites another. */
function unique(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name, index) => {
    const base = name.trim() || `column_${index + 1}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base}_${count}`
  })
}

async function importDelimited(
  table: Table,
  source: ImportSource,
  delimiter: string,
  options: ImportOptions,
): Promise<number> {
  const header = options.header ?? !options.columns
  const parser = (await stream(source.path)).pipe(
    parse({
      delimiter,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
    }),
  )
  let names: string[] | null = options.columns ? unique(options.columns) : null
  let count = 0
  let first = true
  for await (const cells of parser as AsyncIterable<string[]>) {
    if (first && header) {
      first = false
      if (!names) names = unique(cells)
      continue
    }
    first = false
    const record: Record<string, unknown> = {}
    cells.forEach((cell, index) => {
      record[names?.[index] ?? `column_${index + 1}`] = cell === '' ? null : cell
    })
    table.insert(source.label, record)
    count += 1
  }
  return count
}

/** A JSON value as one row: an object's keys are its columns; anything else is `value`. */
function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value }
}

async function importJsonLines(table: Table, source: ImportSource): Promise<number> {
  let count = 0
  for await (const line of lines(source.path)) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      // A line that is not JSON is kept as text, not skipped.
      value = { _line: line }
    }
    table.insert(source.label, recordOf(value))
    count += 1
  }
  return count
}

async function importJson(table: Table, source: ImportSource): Promise<number> {
  const chunks: Buffer[] = []
  for await (const chunk of await stream(source.path)) chunks.push(chunk as Buffer)
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  const items = Array.isArray(value)
    ? value
    : Array.isArray((value as { rows?: unknown })?.rows)
      ? (value as { rows: unknown[] }).rows
      : [value]
  for (const item of items) table.insert(source.label, recordOf(item))
  return items.length
}

async function importParquet(table: Table, source: ImportSource): Promise<number> {
  const file = await asyncBufferFromFile(source.path)
  const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[]
  for (const row of rows) table.insert(source.label, row)
  return rows.length
}

async function importS3AccessLog(table: Table, source: ImportSource): Promise<number> {
  let count = 0
  for await (const line of lines(source.path)) {
    const fields = s3AccessFields(line)
    const record: Record<string, unknown> = {}
    if (fields) {
      fields.forEach((field, index) => {
        record[S3_ACCESS_FIELDS[index] ?? `field_${index + 1}`] = field === '-' ? null : field
      })
      record.time_iso = logTime(fields[2] ?? '')
    }
    record.raw = line
    table.insert(source.label, record)
    count += 1
  }
  return count
}

async function importLines(table: Table, source: ImportSource): Promise<number> {
  let count = 0
  for await (const line of lines(source.path)) {
    count += 1
    table.insert(source.label, { line_no: count, line })
  }
  return count
}

/**
 * Import one or more sources into a new dataset file. Every source is read in
 * the same format; rows keep the source they came from in `_source`.
 */
export async function importDataset(
  sources: ImportSource[],
  destPath: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const first = sources[0]
  if (!first) throw new Error('Nothing to import.')
  const format = options.format ?? (await detectFormat(first.path, first.label))
  mkdirSync(dirname(destPath), { recursive: true })
  if (existsSync(destPath)) rmSync(destPath)
  const db = new DatabaseSync(destPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    const table = new Table(db)
    let rows = 0
    db.exec('BEGIN')
    try {
      for (const source of sources) {
        rows +=
          format === 'csv'
            ? await importDelimited(table, source, ',', options)
            : format === 'tsv'
              ? await importDelimited(table, source, '\t', options)
              : format === 'jsonl'
                ? await importJsonLines(table, source)
                : format === 'json'
                  ? await importJson(table, source)
                  : format === 'parquet'
                    ? await importParquet(table, source)
                    : format === 's3_access_log'
                      ? await importS3AccessLog(table, source)
                      : await importLines(table, source)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { format, rows, columns: table.columns }
  } finally {
    db.close()
  }
}

/** The columns of a dataset's `rows` table. */
export function columnsOf(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (db.prepare('PRAGMA table_info(rows)').all() as { name: string }[]).map((c) => c.name)
  } finally {
    db.close()
  }
}

export function datasetBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
