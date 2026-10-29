/**
 * The turn ledger: what the current turn has read, folded from durable entries.
 *
 * It serves the agent loop's guards in the main process (repeated reads, the
 * round budget) and the reading records Home shows. It is not shown in the
 * conversation: the agent says what it read. Nothing here lives in memory
 * between calls; a restarted process rebuilds the same ledger from the entries.
 */
import type { Live, PermissionGap, ToolName, ToolStatus, ToolView, UiEntry } from './contract'

export interface CallFact {
  id: string
  name: ToolName
  target: string
  status: ToolStatus
  note: string | null
  args: string | null
  ms: number | null
  at: string
  view: ToolView | null
  evidenceId?: string
}

export interface CoverageFact {
  provider: string
  providerId?: string
  /** The account-wide public access block: on, partial, off, unknown, or n/a off AWS. */
  accountBlock: 'on' | 'partial' | 'off' | 'unknown' | 'n/a' | null
  capacity: { bytes: number; objects: number; monthlyUsd: number; buckets: number } | null
  visible: number
  processed: number
  pending: number
  denied: string[]
  unknown: string[]
  gone: string[]
  truncated: boolean
  at: string
}

export interface BlindFact {
  key: string
  bucket: string
  title: string
  /** The review that found it; a different aspect does not clear it. */
  aspect: 'security' | 'lifecycle' | 'observability' | 'access'
  sourceId: string
}

export interface UndecidedFact {
  code: string
  title: string
  /** Up to 20 bucket names; `count` is the full number. */
  buckets: string[]
  count: number
}

export interface Ledger {
  /** Index of the user message that started the current turn; -1 when the task has none. */
  start: number
  /** The current turn's calls with an argument key, and how their last attempt ended. */
  calls: Map<string, { attempts: number; last: 'done' | 'failed' }>
  /** The current turn's tool calls, live ones included. Control tools are not calls. */
  checks: CallFact[]
  coverage: CoverageFact[]
  blind: BlindFact[]
  undecided: UndecidedFact[]
  /** The freshest successful storage read in the run. */
  lastReadAt: string | null
}

/** The one deterministic read status shared by the window, Home and reading records. */
export interface ReadState {
  complete: boolean
  open: number
  blocked: number
  pending: number
  unread: number
  denied: number
  unknown: number
  truncated: number
  failed: number
  access: number
  undecided: number
  permissions: PermissionGap[]
  visible: number
  processed: number
  running: boolean
}

const STORAGE_READS = new Set<ToolName>([
  'survey',
  'buckets',
  'objects',
  'object',
  'config',
  'probe',
  'query',
])
const NOT_CALLS = new Set<ToolName>(['plan', 'ask', 'skill', 'accept_risk'])
const NOT_READS = new Set<ToolName>(['estate', 'change_plan', 'note'])
const UNFINISHED = new Set<ToolStatus>(['failed', 'refused', 'stopped', 'timeout'])

function later(a: string | null, b: string): string {
  if (!a) return b
  return Date.parse(b) > Date.parse(a) ? b : a
}

/** The index of the user message that starts the current turn. */
export function runStart(entries: readonly UiEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1)
    if (entries[index]!.kind === 'user') return index
  return -1
}

function accessGap(view: ToolView): number {
  if (view.kind !== 'config' && view.kind !== 'query') return 0
  const coverage = view.kind === 'config' ? view.accessCoverage : view.coverage
  const blind = (view.kind === 'config' ? view.accessBlind?.length : view.blind?.length) ?? 0
  const open = coverage
    ? Math.max(0, coverage.principals - coverage.evaluated) +
      Math.max(0, coverage.undecided) +
      (coverage.truncated ? 1 : 0) +
      Math.max(0, (coverage.bucketsTotal ?? 0) - (coverage.bucketsExamined ?? 0))
    : 0
  return open + blind
}

function foldCoverage(coverage: Map<string, CoverageFact>, view: ToolView, at: string): void {
  if (view.kind !== 'survey') return
  const key = view.providerId ?? view.provider
  const existing = coverage.get(key)
  // A narrowed re-read is useful for its buckets, but it cannot speak for the
  // account. Merge it into an existing account reading; never replace one.
  if (!view.scoped) {
    coverage.set(key, {
      provider: view.provider,
      providerId: view.providerId,
      accountBlock: view.account?.pab ?? null,
      capacity: view.capacity ?? null,
      visible: view.coverage.visible,
      processed: view.coverage.processed,
      pending: view.coverage.pending ?? 0,
      denied: view.coverage.denied,
      unknown: view.coverage.unknown,
      gone: view.coverage.gone ?? [],
      truncated: view.coverage.truncated,
      at,
    })
    return
  }
  // Without an account survey in this run, one bucket proves only itself: it
  // is a live read, never account coverage.
  if (!existing) return
  const read = new Set(view.buckets.rows.map((row) => String(row[0])))
  coverage.set(key, {
    ...existing,
    processed: Math.min(
      existing.visible,
      existing.processed + Math.max(0, view.coverage.processed),
    ),
    // A narrowed read cannot say which pending bucket it covered.
    pending: existing.pending,
    denied: [
      ...new Set([
        ...existing.denied.filter((bucket) => !read.has(bucket)),
        ...view.coverage.denied,
      ]),
    ],
    unknown: [
      ...new Set([
        ...existing.unknown.filter((bucket) => !read.has(bucket)),
        ...view.coverage.unknown,
      ]),
    ],
    truncated: existing.truncated || view.coverage.truncated,
    at: later(existing.at, at),
  })
}

export function foldLedger(entries: readonly UiEntry[], live?: Live | null): Ledger {
  const start = runStart(entries)
  const calls: Ledger['calls'] = new Map()
  const checks: CallFact[] = []
  for (const entry of entries.slice(Math.max(0, start))) {
    if (entry.kind !== 'tool') continue
    if (entry.key) {
      const previous = calls.get(entry.key)
      calls.set(entry.key, {
        attempts: (previous?.attempts ?? 0) + 1,
        last: entry.status === 'done' ? 'done' : 'failed',
      })
    }
    if (NOT_CALLS.has(entry.name)) continue
    checks.push({
      id: entry.id,
      name: entry.name,
      target: entry.target,
      status: entry.status,
      note: entry.note,
      args: entry.args ?? null,
      ms: entry.ms,
      at: entry.at,
      view: entry.view,
      ...(entry.evidenceId ? { evidenceId: entry.evidenceId } : {}),
    })
  }
  for (const tool of live?.tools ?? []) {
    if (NOT_CALLS.has(tool.name)) continue
    if (checks.some((check) => check.evidenceId === tool.callId)) continue
    checks.push({
      id: `live:${tool.callId}`,
      name: tool.name,
      target: tool.target,
      status: tool.status ?? 'running',
      note: tool.note,
      args: tool.args ?? null,
      ms: null,
      at: tool.startedAt,
      view: null,
    })
  }

  const coverage = new Map<string, CoverageFact>()
  const blind = new Map<string, BlindFact>()
  const undecided = new Map<string, { code: string; title: string; buckets: Set<string> }>()
  let lastReadAt: string | null = null
  for (const check of checks) {
    if (check.status !== 'done' || !check.view) continue
    const view = check.view
    if (STORAGE_READS.has(check.name) && check.at) lastReadAt = later(lastReadAt, check.at)
    foldCoverage(coverage, view, check.at)
    if (view.kind === 'survey') {
      for (const item of view.undecided ?? []) {
        const existing = undecided.get(item.code)
        if (existing) existing.buckets.add(item.bucket)
        else
          undecided.set(item.code, {
            code: item.code,
            title: item.title,
            buckets: new Set([item.bucket]),
          })
      }
    }
    if (view.kind === 'config') {
      const aspect = view.aspect ?? 'security'
      // A repeated review of the same aspect replaces its blind spots.
      for (const [key, item] of [...blind])
        if (item.bucket === view.bucket && item.aspect === aspect) blind.delete(key)
      for (const finding of view.findings) {
        if (finding.severity !== 'blind') continue
        const key = `${view.bucket}:${aspect}:${finding.code ?? finding.title}`
        blind.set(key, {
          key,
          bucket: view.bucket,
          title: finding.title,
          aspect,
          sourceId: check.id,
        })
      }
    }
  }

  return {
    start,
    calls,
    checks,
    coverage: [...coverage.values()],
    blind: [...blind.values()],
    undecided: [...undecided.values()]
      .map((item) => ({
        code: item.code,
        title: item.title,
        buckets: [...item.buckets].slice(0, 20),
        count: item.buckets.size,
      }))
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)),
    lastReadAt,
  }
}

/** What the run's readings leave open, for one account or all of them. */
export function readState(ledger: Ledger, providerId?: string): ReadState {
  const coverage = providerId
    ? ledger.coverage.filter((item) => item.providerId === providerId)
    : ledger.coverage
  const checks = providerId
    ? ledger.checks.filter((check) => {
        const id = (check.view as { providerId?: string } | null)?.providerId
        return !check.view || !id || id === providerId
      })
    : ledger.checks
  const unread = new Set(coverage.flatMap((item) => [...item.denied, ...item.unknown])).size
  const denied = coverage.reduce((n, item) => n + item.denied.length, 0)
  const unknown = coverage.reduce((n, item) => n + item.unknown.length, 0)
  const pending = coverage.reduce((n, item) => n + item.pending, 0)
  const truncated = coverage.reduce(
    (n, item) =>
      n + (item.truncated ? Math.max(0, item.visible - item.processed - item.pending) : 0),
    0,
  )
  const permissions = [
    ...new Map(
      checks
        .flatMap((check) =>
          check.view?.kind === 'survey' || check.view?.kind === 'config'
            ? (check.view.permissions ?? [])
            : [],
        )
        .map((gap) => [`${gap.bucket}:${gap.action}`, gap]),
    ).values(),
  ]
  const reads = checks.filter((check) => !NOT_READS.has(check.name))
  const failed = reads.filter((check) => UNFINISHED.has(check.status)).length
  const running = reads.some((check) => check.status === 'running')
  // The latest reading of one bucket aspect (or one query) replaces earlier ones.
  const access = new Map<string, number>()
  for (const check of checks) {
    const view = check.view
    if (check.status !== 'done' || !view) continue
    if (view.kind === 'config')
      access.set(
        `config:${view.providerId ?? ''}:${view.bucket}:${view.aspect ?? 'security'}`,
        accessGap(view),
      )
    else if (view.kind === 'query')
      access.set(`query:${view.providerId ?? ''}:${view.title}`, accessGap(view))
  }
  const accessOpen = [...access.values()].reduce((total, gap) => total + gap, 0)
  const undecided = ledger.undecided.reduce((n, item) => n + item.count, 0)
  const blocked = unread + permissions.length + ledger.blind.length + failed + accessOpen
  const open = pending + truncated + blocked + undecided
  return {
    complete: coverage.length > 0 && open === 0 && !running,
    open,
    blocked,
    pending,
    unread,
    denied,
    unknown,
    truncated,
    failed,
    access: accessOpen,
    undecided,
    permissions,
    visible: coverage.reduce((n, item) => n + item.visible, 0),
    processed: coverage.reduce((n, item) => n + item.processed, 0),
    running,
  }
}
