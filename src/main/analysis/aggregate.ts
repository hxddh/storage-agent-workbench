import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Table } from '@shared/contract'

export type DatasetKind = 'access_log' | 'inventory'

const TABLES: Record<DatasetKind, string> = {
  access_log: 'access_logs',
  inventory: 'inventory_objects',
}

const WEEKDAY = `CASE CAST(strftime('%w', timestamp) AS INTEGER)
  WHEN 0 THEN '0 Sun' WHEN 1 THEN '1 Mon' WHEN 2 THEN '2 Tue' WHEN 3 THEN '3 Wed'
  WHEN 4 THEN '4 Thu' WHEN 5 THEN '5 Fri' ELSE '6 Sat' END`

const ACCESS_DIMENSIONS: Record<string, string> = {
  status_code: 'status_code',
  method: 'method',
  key: 'key',
  path: 'path',
  prefix: 'prefix',
  user_agent: 'user_agent',
  client_ip_masked: 'client_ip_masked',
  error_code: 'error_code',
  hour: `CASE WHEN timestamp IS NULL THEN 'unknown' ELSE strftime('%Y-%m-%dT%H:00', timestamp) END`,
  day: `CASE WHEN timestamp IS NULL THEN 'unknown' ELSE strftime('%Y-%m-%d', timestamp) END`,
  weekday: `CASE WHEN timestamp IS NULL THEN 'unknown' ELSE ${WEEKDAY} END`,
}

const INVENTORY_DIMENSIONS: Record<string, string> = {
  bucket: 'bucket',
  prefix: 'prefix',
  storage_class: 'storage_class',
}

const ACCESS_METRICS: Record<string, string> = {
  count: 'count(*)',
  sum_bytes: 'sum(bytes_sent)',
  avg_bytes: 'avg(bytes_sent)',
  min_bytes: 'min(bytes_sent)',
  max_bytes: 'max(bytes_sent)',
  avg_latency_ms: 'avg(latency_ms)',
  max_latency_ms: 'max(latency_ms)',
  distinct_ips: 'count(DISTINCT client_ip_masked)',
  distinct_keys: 'count(DISTINCT key)',
}

const ACCESS_PERCENTILES: Record<string, number> = {
  p50_latency_ms: 0.5,
  p95_latency_ms: 0.95,
  p99_latency_ms: 0.99,
}

const INVENTORY_METRICS: Record<string, string> = {
  count: 'count(*)',
  total_size: 'sum(size)',
  avg_size: 'avg(size)',
  max_size: 'max(size)',
  min_size: 'min(size)',
  distinct_prefixes: 'count(DISTINCT prefix)',
  distinct_storage_classes: 'count(DISTINCT storage_class)',
}

const ACCESS_FILTERS = new Set([
  'status_code',
  'method',
  'key',
  'path',
  'prefix',
  'user_agent',
  'client_ip_masked',
  'error_code',
])
const INVENTORY_FILTERS = new Set(['bucket', 'prefix', 'storage_class'])

export const MAX_GROUPS = 50

export class AggregationError extends Error {}

function requireValue<T>(
  kind: string,
  value: string,
  allowed: Record<string, T> | Set<string>,
): void {
  const ok = allowed instanceof Set ? allowed.has(value) : value in allowed
  if (!ok) {
    const names = allowed instanceof Set ? [...allowed] : Object.keys(allowed)
    throw new AggregationError(`Unknown ${kind} '${value}'. Allowed: ${names.sort().join(', ')}.`)
  }
}

export interface AggregateRequest {
  metric: string
  groupBy?: string | null
  groupBy2?: string | null
  filters?: Record<string, string | number> | null
  statusMin?: number | null
  statusMax?: number | null
  limit?: number | null
}

export interface AggregateResult {
  metric: string
  groupBy: string | null
  value?: number | null
  groups?: { group: string; value: number }[]
  truncated: boolean
  sql: string
  params: (string | number)[]
}

export function aggregate(
  path: string,
  kind: DatasetKind,
  request: AggregateRequest,
): AggregateResult {
  if (!existsSync(path)) throw new AggregationError('This dataset has no analytical database yet.')
  const table = TABLES[kind]
  const dimensions = kind === 'access_log' ? ACCESS_DIMENSIONS : INVENTORY_DIMENSIONS
  const metrics = kind === 'access_log' ? ACCESS_METRICS : INVENTORY_METRICS
  const filters = kind === 'access_log' ? ACCESS_FILTERS : INVENTORY_FILTERS
  const percentile = kind === 'access_log' ? ACCESS_PERCENTILES[request.metric] : undefined
  if (!(request.metric in metrics) && percentile === undefined) {
    requireValue('metric', request.metric, metrics)
  }

  const where: string[] = []
  const params: (string | number)[] = []
  for (const [column, value] of Object.entries(request.filters ?? {})) {
    requireValue('filter column', column, filters)
    where.push(`${column} = ?`)
    params.push(value)
  }
  if (kind === 'access_log') {
    if (request.statusMin !== null && request.statusMin !== undefined) {
      where.push('status_code >= ?')
      params.push(request.statusMin)
    }
    if (request.statusMax !== null && request.statusMax !== undefined) {
      where.push('status_code <= ?')
      params.push(request.statusMax)
    }
  } else if (request.statusMin || request.statusMax) {
    throw new AggregationError('status_min/status_max apply only to access logs.')
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    if (percentile !== undefined) {
      if (request.groupBy)
        throw new AggregationError('A percentile cannot be grouped; drop group_by.')
      const pctWhere = ` WHERE ${[...where, 'latency_ms IS NOT NULL'].join(' AND ')}`
      const sql = `WITH filtered AS (SELECT latency_ms AS v FROM ${table}${pctWhere})
        SELECT (SELECT v FROM filtered ORDER BY v LIMIT 1 OFFSET
          CAST((SELECT count(*) - 1 FROM filtered) * ? AS INTEGER)) AS value`
      const row = db.prepare(sql).get(...params, percentile) as { value: number | null } | undefined
      return {
        metric: request.metric,
        groupBy: null,
        value: row?.value ?? null,
        truncated: false,
        sql,
        params,
      }
    }

    if (!request.groupBy) {
      const sql = `SELECT ${metrics[request.metric]} AS value FROM ${table}${whereSql}`
      const row = db.prepare(sql).get(...params) as { value: number | null } | undefined
      return {
        metric: request.metric,
        groupBy: null,
        value: row?.value ?? null,
        truncated: false,
        sql,
        params,
      }
    }

    requireValue('group_by', request.groupBy, dimensions)
    const second = request.groupBy2 ? dimensions[request.groupBy2] : null
    if (request.groupBy2) requireValue('group_by', request.groupBy2, dimensions)
    const first = dimensions[request.groupBy]!
    const limit = Math.max(1, Math.min(request.limit ?? 20, MAX_GROUPS))
    const label = second ? `(${first}) || ' / ' || (${second})` : first
    const sql = `SELECT ${label} AS g, ${metrics[request.metric]} AS v
      FROM ${table}${whereSql}
      GROUP BY g ORDER BY v DESC LIMIT ?`
    const rows = db.prepare(sql).all(...params, limit) as { g: string | null; v: number | null }[]
    return {
      metric: request.metric,
      groupBy: request.groupBy,
      groups: rows.map((row) => ({
        group: row.g === null ? 'unknown' : String(row.g),
        value: row.v ?? 0,
      })),
      truncated: rows.length >= limit,
      sql,
      params,
    }
  } finally {
    db.close()
  }
}

export function preview(path: string, kind: DatasetKind, limit = 5): Table {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const table = TABLES[kind]
    const rows = db.prepare(`SELECT * FROM ${table} LIMIT ?`).all(limit) as Record<
      string,
      unknown
    >[]
    const columns =
      rows.length > 0
        ? Object.keys(rows[0]!)
        : (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    return {
      columns,
      rows: rows.map((row) =>
        columns.map((column) => (row[column] ?? null) as string | number | null),
      ),
    }
  } finally {
    db.close()
  }
}
