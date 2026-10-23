import { redact } from '../security/redact'

export type LogFormat = 'jsonl' | 'text' | 'csv' | 'inventory' | 'unknown'

const CSV_TOKENS = new Set([
  'timestamp',
  'time',
  'ts',
  'method',
  'verb',
  'path',
  'key',
  'uri',
  'request',
  'status',
  'status_code',
  'bytes',
  'bytes_sent',
  'size',
  'latency_ms',
  'latency',
  'duration_ms',
  'user_agent',
  'ua',
  'remote_ip',
  'client_ip',
  'ip',
  'request_id',
  'req_id',
])

const INVENTORY_ONLY = new Set([
  'storage_class',
  'last_modified_date',
  'is_latest',
  'is_delete_marker',
  'version_id',
  'e_tag',
  'etag',
  'is_multipart_uploaded',
  'replication_status',
  'encryption_status',
  'intelligent_tiering_access_tier',
  'checksum_algorithm',
])

const REQUEST_ONLY = new Set([
  'status',
  'status_code',
  'method',
  'verb',
  'user_agent',
  'ua',
  'remote_ip',
  'client_ip',
  'latency',
  'latency_ms',
  'duration_ms',
  'request_id',
  'req_id',
  'bytes_sent',
  'uri',
])

export const TEXT_RE =
  /^(?<ts>\S+)\s+(?<bucket>\S+)\s+(?<method>[A-Z]+)\s+(?<path>\S+)\s+(?<status>\d{3})\s+(?<bytes>\d+)\s+(?<latency>\d+)\s*ms\s+user-agent="(?<ua>[^"]*)"\s+remote_ip="(?<ip>[^"]*)"/

export const CLF_RE =
  /^(?<ip>\S+)\s+\S+\s+\S+\s+\[(?<ts>[^\]]+)\]\s+"(?<method>[A-Z]+)\s+(?<path>\S+)[^"]*"\s+(?<status>\d{3})\s+(?<bytes>\S+)(?:\s+"[^"]*"\s+"(?<ua>[^"]*)")?/

export function detectFormat(lines: string[]): LogFormat {
  const first = lines[0]
  if (!first) return 'unknown'
  if (first.startsWith('{')) {
    try {
      JSON.parse(first)
      return 'jsonl'
    } catch {
      return 'unknown'
    }
  }
  if (TEXT_RE.test(first) || CLF_RE.test(first)) return 'text'
  if (first.includes(',') || first.includes('\t')) {
    const delimiter = first.includes('\t') ? '\t' : ','
    const cells = new Set(
      first.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase()),
    )
    if (
      [...cells].some((c) => INVENTORY_ONLY.has(c)) &&
      ![...cells].some((c) => REQUEST_ONLY.has(c))
    ) {
      return 'inventory'
    }
    if ([...cells].some((c) => CSV_TOKENS.has(c))) return 'csv'
  }
  return 'unknown'
}

const EPOCH = /^(?:\d{10}(?:\.\d+)?|\d{13}|\d{16}|\d{19})$/
const EPOCH_DIVISOR: Record<number, number> = { 10: 1, 13: 1e3, 16: 1e6, 19: 1e9 }

function toUtcIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const s = String(value).trim()
  if (!s) return null
  if (EPOCH.test(s)) {
    const width = s.split('.')[0]!.length
    const ms = (Number(s) / EPOCH_DIVISOR[width]!) * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? s : toUtcIso(date)
  }
  if (/^\d{12}$/.test(s)) {
    const date = new Date(
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00Z`,
    )
    return Number.isNaN(date.getTime()) ? s : toUtcIso(date)
  }
  if (/^\d{14}$/.test(s)) {
    const date = new Date(
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`,
    )
    return Number.isNaN(date.getTime()) ? s : toUtcIso(date)
  }
  const clf = s.match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/)
  if (clf) {
    const [, day, month, year, hour, minute, second, zone] = clf
    const monthIndex = MONTHS.indexOf(month!)
    if (monthIndex >= 0) {
      const base = Date.UTC(
        Number(year),
        monthIndex,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      )
      let offset = 0
      if (zone) {
        const sign = zone.startsWith('-') ? -1 : 1
        offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)))
      }
      return toUtcIso(new Date(base - offset * 60_000))
    }
  }
  const date = new Date(s)
  return Number.isNaN(date.getTime()) ? s : toUtcIso(date)
}

export function maskIp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const s = String(value).trim()
  if (!s) return null
  const v4 = s.split('.')
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part))) {
    return `${v4[0]}.${v4[1]}.${v4[2]}.0`
  }
  if (s.includes(':')) {
    const groups = s.split(':').filter(Boolean)
    return `${groups.slice(0, 4).join(':')}::`
  }
  return s
}

export function prefixOf(key: string): string {
  const clean = key.replace(/^\/+/, '')
  const index = clean.indexOf('/')
  return index >= 0 ? `${clean.slice(0, index)}/` : '(root)'
}

export function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === '-') return null
  const s = String(value).trim()
  const int = Number.parseInt(s, 10)
  if (Number.isFinite(int)) return int
  const float = Number.parseFloat(s)
  return Number.isFinite(float) ? Math.trunc(float) : null
}

export interface AccessRow {
  timestamp: string | null
  method: string | null
  key: string
  path: string | null
  prefix: string
  status_code: number | null
  bytes_sent: number | null
  latency_ms: number | null
  user_agent: string | null
  client_ip_masked: string | null
  request_id: string | null
  error_code: string | null
  raw_sanitized: string | null
}

export function accessRow(input: {
  ts?: unknown
  method?: unknown
  path?: unknown
  status?: unknown
  bytes?: unknown
  latency?: unknown
  ua?: unknown
  ip?: unknown
  requestId?: unknown
  raw?: string
}): AccessRow {
  const path = input.path === null || input.path === undefined ? null : redact(String(input.path))
  const key = (path ?? '').replace(/^\/+/, '')
  return {
    timestamp: normalizeTimestamp(input.ts),
    method: input.method ? String(input.method) : null,
    key,
    path,
    prefix: prefixOf(key),
    status_code: toInt(input.status),
    bytes_sent: toInt(input.bytes),
    latency_ms: toInt(input.latency),
    user_agent: input.ua ? redact(String(input.ua)).slice(0, 500) : null,
    client_ip_masked: maskIp(input.ip),
    request_id: input.requestId ? String(input.requestId).slice(0, 200) : null,
    error_code: null,
    raw_sanitized: input.raw ? redact(input.raw).slice(0, 500) : null,
  }
}

export interface InventoryRow {
  bucket: string
  key: string
  prefix: string
  size: number | null
  storage_class: string | null
  timestamp: string | null
}

export function inventoryRow(input: {
  bucket?: unknown
  key?: unknown
  size?: unknown
  storageClass?: unknown
  timestamp?: unknown
  fallbackBucket: string
}): InventoryRow {
  const key =
    input.key === null || input.key === undefined
      ? ''
      : redact(String(input.key)).replace(/^\/+/, '')
  return {
    bucket: input.bucket ? String(input.bucket).slice(0, 200) : input.fallbackBucket,
    key,
    prefix: prefixOf(key),
    size: toInt(input.size),
    storage_class: input.storageClass ? String(input.storageClass).slice(0, 40) : null,
    timestamp: normalizeTimestamp(input.timestamp),
  }
}
