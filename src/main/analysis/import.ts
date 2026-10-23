import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { createGunzip } from 'node:zlib'
import { parse } from 'csv-parse'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import {
  type AccessRow,
  accessRow,
  CLF_RE,
  detectFormat,
  type InventoryRow,
  inventoryRow,
  TEXT_RE,
} from './formats'

export const MAX_INGEST_ROWS = 2_000_000

export interface ImportResult {
  kind: 'access_log' | 'inventory'
  rows: number
  truncated: boolean
  columns: string[]
}

const ACCESS_COLUMNS = [
  'timestamp',
  'method',
  'key',
  'path',
  'prefix',
  'status_code',
  'bytes_sent',
  'latency_ms',
  'user_agent',
  'client_ip_masked',
  'request_id',
  'error_code',
  'raw_sanitized',
]

const INVENTORY_COLUMNS = ['bucket', 'key', 'prefix', 'size', 'storage_class', 'timestamp']

function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) rmSync(path)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  return db
}

function createAccessTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE access_logs (
    timestamp TEXT, method TEXT, key TEXT, path TEXT, prefix TEXT,
    status_code INTEGER, bytes_sent INTEGER, latency_ms INTEGER,
    user_agent TEXT, client_ip_masked TEXT, request_id TEXT, error_code TEXT,
    raw_sanitized TEXT
  )`)
}

function createInventoryTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE inventory_objects (
    bucket TEXT, key TEXT, prefix TEXT, size INTEGER, storage_class TEXT, timestamp TEXT
  )`)
}

export async function sampleLines(path: string, count = 20): Promise<string[]> {
  const out: string[] = []
  const file = await open(path)
  try {
    const buffer = Buffer.alloc(256 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      out.push(trimmed)
      if (out.length >= count) break
    }
  } finally {
    await file.close()
  }
  return out
}

function readStream(path: string) {
  const base = createReadStream(path)
  return path.endsWith('.gz') ? base.pipe(createGunzip()) : base
}

async function* textLines(path: string): AsyncGenerator<string> {
  const reader = createInterface({ input: readStream(path), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of reader) {
    if (line.trim()) yield line
  }
}

function pick(row: Record<string, string>, names: string[]): string | undefined {
  const lower = new Map(Object.keys(row).map((key) => [key.trim().toLowerCase(), key]))
  for (const name of names) {
    const key = lower.get(name)
    if (key) return row[key]
  }
  return undefined
}

async function importAccessFromCsv(
  db: DatabaseSync,
  path: string,
  delimiter: string,
): Promise<number> {
  const parser = readStream(path).pipe(
    parse({
      columns: true,
      delimiter,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }),
  )
  const stmt = db.prepare(
    `INSERT INTO access_logs (${ACCESS_COLUMNS.join(',')}) VALUES (${ACCESS_COLUMNS.map(() => '?').join(',')})`,
  )
  let count = 0
  db.exec('BEGIN')
  try {
    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      if (count >= MAX_INGEST_ROWS) break
      const record = accessRow({
        ts: pick(row, ['timestamp', 'time', 'ts']),
        method: pick(row, ['method', 'verb']),
        path: pick(row, ['path', 'key', 'uri', 'request']),
        status: pick(row, ['status', 'status_code']),
        bytes: pick(row, ['bytes', 'bytes_sent', 'size']),
        latency: pick(row, ['latency_ms', 'latency', 'duration_ms']),
        ua: pick(row, ['user_agent', 'ua']),
        ip: pick(row, ['remote_ip', 'client_ip', 'ip']),
        requestId: pick(row, ['request_id', 'req_id']),
      })
      stmt.run(...accessValues(record))
      count += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return count
}

function accessValues(row: AccessRow): (string | number | null)[] {
  return [
    row.timestamp,
    row.method,
    row.key,
    row.path,
    row.prefix,
    row.status_code,
    row.bytes_sent,
    row.latency_ms,
    row.user_agent,
    row.client_ip_masked,
    row.request_id,
    row.error_code,
    row.raw_sanitized,
  ]
}

async function importAccessFromLines(db: DatabaseSync, path: string): Promise<number> {
  const stmt = db.prepare(
    `INSERT INTO access_logs (${ACCESS_COLUMNS.join(',')}) VALUES (${ACCESS_COLUMNS.map(() => '?').join(',')})`,
  )
  let count = 0
  db.exec('BEGIN')
  try {
    for await (const line of textLines(path)) {
      if (count >= MAX_INGEST_ROWS) break
      const trimmed = line.trim()
      if (!trimmed) continue
      let record: AccessRow
      if (trimmed.startsWith('{')) {
        let json: Record<string, unknown>
        try {
          json = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }
        record = accessRow({
          ts: json.timestamp ?? json.time ?? json.ts,
          method: json.method ?? json.verb,
          path: json.path ?? json.key ?? json.uri ?? json.request,
          status: json.status ?? json.status_code,
          bytes: json.bytes ?? json.bytes_sent ?? json.size,
          latency: json.latency_ms ?? json.latency ?? json.duration_ms,
          ua: json.user_agent ?? json.ua,
          ip: json.remote_ip ?? json.client_ip ?? json.ip,
          requestId: json.request_id ?? json.req_id,
          raw: trimmed,
        })
      } else {
        const match = TEXT_RE.exec(trimmed) ?? CLF_RE.exec(trimmed)
        if (match?.groups) {
          record = accessRow({
            ts: match.groups.ts,
            method: match.groups.method,
            path: match.groups.path,
            status: match.groups.status,
            bytes: match.groups.bytes,
            latency: match.groups.latency,
            ua: match.groups.ua,
            ip: match.groups.ip,
            raw: trimmed,
          })
        } else {
          record = accessRow({ raw: trimmed })
        }
      }
      stmt.run(...accessValues(record))
      count += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return count
}

function inventoryValues(row: InventoryRow): (string | number | null)[] {
  return [row.bucket, row.key, row.prefix, row.size, row.storage_class, row.timestamp]
}

async function importInventoryFromCsv(
  db: DatabaseSync,
  path: string,
  delimiter: string,
  fallbackBucket: string,
): Promise<number> {
  const parser = readStream(path).pipe(
    parse({
      columns: true,
      delimiter,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }),
  )
  const stmt = db.prepare(
    `INSERT INTO inventory_objects (${INVENTORY_COLUMNS.join(',')}) VALUES (${INVENTORY_COLUMNS.map(() => '?').join(',')})`,
  )
  let count = 0
  db.exec('BEGIN')
  try {
    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      if (count >= MAX_INGEST_ROWS) break
      const record = inventoryRow({
        bucket: pick(row, ['bucket']),
        key: pick(row, ['key', 'object_key', 'object']),
        size: pick(row, ['size', 'object_size', 'bytes']),
        storageClass: pick(row, ['storage_class', 'storageclass', 'storage class']),
        timestamp: pick(row, ['last_modified_date', 'lastmodified', 'last_modified', 'timestamp']),
        fallbackBucket,
      })
      stmt.run(...inventoryValues(record))
      count += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return count
}

async function importInventoryFromParquet(
  db: DatabaseSync,
  path: string,
  fallbackBucket: string,
): Promise<number> {
  const file = await asyncBufferFromFile(path)
  const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[]
  const stmt = db.prepare(
    `INSERT INTO inventory_objects (${INVENTORY_COLUMNS.join(',')}) VALUES (${INVENTORY_COLUMNS.map(() => '?').join(',')})`,
  )
  let count = 0
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      if (count >= MAX_INGEST_ROWS) break
      const record = inventoryRow({
        bucket: row.bucket,
        key: row.key ?? row.object_key,
        size: row.size ?? row.object_size,
        storageClass: row.storage_class ?? row.storageClass,
        timestamp: row.last_modified_date ?? row.lastModified,
        fallbackBucket,
      })
      stmt.run(...inventoryValues(record))
      count += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return count
}

export async function importDataset(input: {
  filePath: string
  destPath: string
  kind?: 'access_log' | 'inventory'
}): Promise<ImportResult> {
  const sample = await sampleLines(input.filePath)
  if (sample.length === 0) throw new Error('The file is empty.')
  const detected = detectFormat(sample)
  const kind = input.kind ?? (detected === 'inventory' ? 'inventory' : 'access_log')
  if (kind === 'access_log' && detected === 'inventory') {
    throw new Error(
      'This file is an object inventory, not access logs. Analyze it as an inventory.',
    )
  }
  const fallbackBucket =
    input.filePath
      .split('/')
      .pop()
      ?.replace(/\.(csv|tsv|parquet|pq|gz)$/i, '') ?? 'inventory'
  const db = openDatabase(input.destPath)
  try {
    if (kind === 'inventory') {
      createInventoryTable(db)
      const lower = input.filePath.toLowerCase()
      const rows =
        lower.endsWith('.parquet') || lower.endsWith('.pq')
          ? await importInventoryFromParquet(db, input.filePath, fallbackBucket)
          : await importInventoryFromCsv(
              db,
              input.filePath,
              lower.endsWith('.tsv') ? '\t' : ',',
              fallbackBucket,
            )
      return {
        kind,
        rows,
        truncated: rows >= MAX_INGEST_ROWS,
        columns: INVENTORY_COLUMNS,
      }
    }
    createAccessTable(db)
    const rows =
      detected === 'csv'
        ? await importAccessFromCsv(db, input.filePath, sample[0]!.includes('\t') ? '\t' : ',')
        : await importAccessFromLines(db, input.filePath)
    return { kind, rows, truncated: rows >= MAX_INGEST_ROWS, columns: ACCESS_COLUMNS }
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
