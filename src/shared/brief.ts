/**
 * One task, one brief.
 *
 * The window does not replay a chat: it projects the task's tool results into a
 * page — a verdict, the findings those results prove now, one data section, the
 * fixes, and the checks that produced them. The model writes the verdict;
 * everything else here is deterministic, so the page cannot contradict the
 * tools.
 *
 * Findings are current state, not history. Results are folded in order: a
 * survey replaces what the task knew about its account, a review replaces what
 * it knew about the rules it read, and a reading that proves a rule clean
 * removes its finding. The estate's current status (an Issue the user has since
 * accepted or another task resolved) is laid over the top.
 *
 * Shared by the renderer and the main process (search indexes the same facts).
 */
import type {
  AttachmentRef,
  ConfigFinding,
  IssueRow,
  NoticeCode,
  Observation,
  PostureChange,
  ReverifyReport,
  Severity,
  ToolName,
  ToolStatus,
  ToolView,
  UiEntry,
} from './contract'
import { contradicted, knownExposure, knownNames, ungrounded } from './grounding'

export interface BriefFinding {
  key: string
  provider: string | null
  bucket: string
  code: string
  title: string
  detail: string | null
  severity: Severity
  /** The AWS Security Hub control, when the rule matches one. */
  control: string | null
  /** The estate Issue behind the finding; null for a review advisory. */
  issueId: string | null
  status: 'open' | 'accepted'
  /** `memory`: last read before this task, by `estate` or for a bucket this survey did not read. */
  source: 'read' | 'memory'
  /** When storage was last read for this finding: the Issue's last observation for memory. */
  readAt: string
  recurred: number
  sourceId: string
  sourceName: ToolName
  at: string
}

export interface BriefData {
  key: string
  kind: ToolView['kind']
  title: string
  view: ToolView
  sourceId: string
  at: string
  memory: boolean
}

export interface BriefFix {
  key: string
  sourceId: string
  view: Extract<ToolView, { kind: 'fix' }>
  at: string
}

export interface BriefCheck {
  id: string
  name: ToolName
  target: string
  status: ToolStatus
  note: string | null
  ms: number | null
  at: string
  view: ToolView | null
}

export interface BriefCoverage {
  provider: string
  /** The account-wide public access block: on, partial, off, unknown, or n/a off AWS. */
  accountBlock: 'on' | 'partial' | 'off' | 'unknown' | 'n/a' | null
  capacity: { bytes: number; objects: number; monthlyUsd: number; buckets: number } | null
  /** Open Issues of the account in the estate when it was surveyed. */
  issueTotal: number | null
  visible: number
  processed: number
  pending: number
  denied: string[]
  unknown: string[]
  gone: string[]
  truncated: boolean
  at: string
}

export interface BriefBlind {
  key: string
  bucket: string
  title: string
  /** The review that found it; a different aspect does not clear it. */
  aspect: 'security' | 'lifecycle' | 'observability' | 'access'
  sourceId: string
}

export interface BriefUndecided {
  code: string
  title: string
  /** Up to 20 bucket names; `count` is the full number. */
  buckets: string[]
  count: number
}

export interface BriefQuestion {
  id: string
  text: string
  at: string
  attachments: AttachmentRef[]
  context?: import('./contract').ContextRef[]
}

export interface BriefNotice {
  id: string
  code?: NoticeCode
  text: string
  tone: 'info' | 'warn' | 'error'
  action?: 'retry' | 'continue'
}

export interface Brief {
  verdict: {
    text: string
    at: string
    streaming: boolean
    /** The verdict answers an earlier question than the latest one. */
    stale: boolean
    /** Backticked names no tool result in the task shows. */
    ungrounded: string[]
    /** Buckets the verdict calls public, or not, against what the readings proved. */
    contradicted: string[]
  } | null
  findings: BriefFinding[]
  accepted: BriefFinding[]
  /** Findings this task saw open and then proved fixed. */
  resolved: BriefFinding[]
  blind: BriefBlind[]
  undecided: BriefUndecided[]
  data: BriefData | null
  fixes: BriefFix[]
  checks: BriefCheck[]
  coverage: BriefCoverage[]
  questions: BriefQuestion[]
  changes: PostureChange[]
  reverify: ReverifyReport | null
  attribution: {
    status: 'ok' | 'denied' | 'unsupported' | 'error'
    events: { at: string; event: string; actor: string }[]
    from?: string
    to?: string
    days?: number
    truncated?: boolean
  } | null
  notices: BriefNotice[]
  /** Sum of the current turn's tool durations; null while it has none. */
  durationMs: number | null
  /** The freshest successful storage read in the task, for the "checked …" line. */
  lastReadAt: string | null
  /** Newest entry in the task, for ordering and the live line. */
  lastAt: string | null
  /** Open Issues across the surveyed accounts; more than `findings` when a view carried only the first ones. */
  issueTotal: number | null
}

export interface LiveInput {
  tools: {
    callId: string
    name: ToolName
    target: string
    note: string | null
    startedAt: string
  }[]
  text: string | null
  startedAt: string
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
const DATA_KINDS = new Set<ToolView['kind']>([
  'query',
  'survey',
  'buckets',
  'objects',
  'object',
  'estate',
  'config',
])
const STORAGE_READS = new Set<ToolName>([
  'survey',
  'buckets',
  'objects',
  'object',
  'config',
  'probe',
  'query',
])

function later(a: string | null, b: string): string {
  if (!a) return b
  return Date.parse(b) > Date.parse(a) ? b : a
}

/** Findings keyed by account, bucket and rule; an unknown account matches any. */
class FindingSet {
  private readonly map = new Map<string, BriefFinding>()
  readonly resolved = new Map<string, BriefFinding>()

  private static key(provider: string | null, bucket: string, code: string): string {
    return `${provider ?? '*'}|${bucket}|${code}`
  }

  private find(provider: string | null, bucket: string, code: string): string | undefined {
    const exact = FindingSet.key(provider, bucket, code)
    if (this.map.has(exact)) return exact
    const suffix = `|${bucket}|${code}`
    for (const key of this.map.keys()) {
      if (key.endsWith(suffix) && (provider === null || key.startsWith('*|'))) return key
    }
    return undefined
  }

  set(finding: BriefFinding): void {
    const existing = this.find(finding.provider, finding.bucket, finding.code)
    const previous = existing ? this.map.get(existing) : undefined
    if (existing) this.map.delete(existing)
    this.resolved.delete(finding.key)
    this.map.set(
      FindingSet.key(finding.provider ?? previous?.provider ?? null, finding.bucket, finding.code),
      {
        ...finding,
        provider: finding.provider ?? previous?.provider ?? null,
        issueId: finding.issueId ?? previous?.issueId ?? null,
        detail: finding.detail ?? previous?.detail ?? null,
      },
    )
  }

  clear(provider: string | null, bucket: string, code: string): void {
    const existing = this.find(provider, bucket, code)
    if (!existing) return
    const finding = this.map.get(existing)!
    this.map.delete(existing)
    if (finding.issueId) this.resolved.set(finding.key, finding)
  }

  /** Drop issue findings of an account (optionally one bucket) that a fresh list leaves out. */
  replaceIssues(provider: string | null, bucket: string | null, keep: Set<string>): void {
    for (const [key, finding] of [...this.map]) {
      if (!finding.issueId) continue
      if (provider && finding.provider && finding.provider !== provider) continue
      if (bucket && finding.bucket !== bucket) continue
      if (keep.has(finding.issueId)) continue
      this.map.delete(key)
      if (finding.source === 'read') this.resolved.set(finding.key, finding)
    }
  }

  values(): BriefFinding[] {
    return [...this.map.values()]
  }

  overlay(status: Record<string, IssueRow['status']>): void {
    for (const [key, finding] of [...this.map]) {
      const now = finding.issueId ? status[finding.issueId] : undefined
      if (!now) continue
      if (now === 'resolved') {
        this.map.delete(key)
        this.resolved.set(finding.key, finding)
      } else if (now !== finding.status) this.map.set(key, { ...finding, status: now })
    }
  }
}

function issueFinding(issue: IssueRow, check: BriefCheck, source: 'read' | 'memory'): BriefFinding {
  return {
    key: `issue:${issue.id}`,
    provider: issue.provider || null,
    bucket: issue.bucket,
    code: issue.code,
    title: issue.title,
    detail: issue.detail ?? null,
    severity: issue.severity,
    control: issue.control ?? null,
    issueId: issue.id,
    status: issue.status === 'accepted' ? 'accepted' : 'open',
    source,
    readAt: source === 'memory' && issue.lastSeenAt ? issue.lastSeenAt : check.at,
    recurred: issue.recurred,
    sourceId: check.id,
    sourceName: check.name,
    at: check.at,
  }
}

function reviewFinding(
  finding: ConfigFinding,
  bucket: string,
  provider: string | null,
  check: BriefCheck,
  issue?: IssueRow,
): BriefFinding {
  const code = finding.code ?? finding.title.toLowerCase()
  return {
    key: `config:${bucket}:${code}`,
    provider,
    bucket,
    code,
    title: finding.title,
    detail: finding.detail || null,
    severity: finding.severity === 'ok' || finding.severity === 'blind' ? 'low' : finding.severity,
    control: issue?.control ?? null,
    issueId: issue?.id ?? null,
    status: issue?.status === 'accepted' ? 'accepted' : 'open',
    source: 'read',
    readAt: check.at,
    recurred: 0,
    sourceId: check.id,
    sourceName: check.name,
    at: check.at,
  }
}

function applyObservations(set: FindingSet, observations: Observation[] | undefined): void {
  for (const observation of observations ?? []) {
    if (!observation.verdict) set.clear(observation.provider, observation.bucket, observation.code)
  }
}

type UndecidedAccumulator = Map<string, { code: string; title: string; buckets: Set<string> }>

function fold(
  set: FindingSet,
  blind: Map<string, BriefBlind>,
  undecided: UndecidedAccumulator,
  check: BriefCheck,
): void {
  const view = check.view
  if (!view) return
  if (view.kind === 'survey') {
    const provider = view.providerId ?? view.issues[0]?.provider ?? null
    applyObservations(set, view.observations)
    // A complete Issue list is the account's whole open list at that moment; a
    // list cut short says nothing about the Issues it left out.
    const open = view.issues.filter((issue) => issue.status === 'open').length
    if (view.issueTotal === undefined || open >= view.issueTotal)
      set.replaceIssues(provider, null, new Set(view.issues.map((issue) => issue.id)))
    const read = new Set(view.buckets.rows.map((row) => String(row[0])))
    if (view.accountRead) read.add('')
    for (const issue of view.issues)
      set.set(issueFinding(issue, check, read.has(issue.bucket) ? 'read' : 'memory'))
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
    return
  }
  if (view.kind === 'estate') {
    const provider = view.providerId ?? null
    set.replaceIssues(provider, view.bucket ?? null, new Set(view.issues.map((issue) => issue.id)))
    for (const issue of view.issues) set.set(issueFinding(issue, check, 'memory'))
    return
  }
  if (view.kind === 'config') {
    const provider = view.providerId ?? null
    applyObservations(set, view.observations)
    const aspect = view.aspect ?? 'security'
    for (const key of [...blind.keys()]) {
      const item = blind.get(key)!
      if (item.bucket === view.bucket && item.aspect === aspect) blind.delete(key)
    }
    for (const finding of view.findings) {
      if (finding.severity === 'ok') continue
      if (finding.severity === 'blind') {
        const key = `${view.bucket}:${aspect}:${finding.code ?? finding.title}`
        blind.set(key, {
          key,
          bucket: view.bucket,
          title: finding.title,
          aspect,
          sourceId: check.id,
        })
        continue
      }
      const issue = view.issues?.find(
        (item) => item.bucket === view.bucket && item.code === finding.code,
      )
      set.set(reviewFinding(finding, view.bucket, provider, check, issue))
    }
  }
}

export function buildBrief(
  entries: readonly UiEntry[],
  live?: LiveInput | null,
  issueStatus: Record<string, IssueRow['status']> = {},
): Brief {
  const questions: BriefQuestion[] = []
  const checks: BriefCheck[] = []
  const notices: BriefNotice[] = []
  const answers: { text: string; at: string; index: number }[] = []
  let lastAt: string | null = null
  let boundary = -1
  let lastQuestionIndex = -1
  const pending: { index: number; notice: BriefNotice }[] = []

  let reverify: ReverifyReport | null = null
  entries.forEach((entry, index) => {
    if (entry.at) lastAt = later(lastAt, entry.at)
    if (entry.kind === 'user') {
      questions.push({
        id: entry.id,
        text: entry.text,
        at: entry.at,
        attachments: entry.attachments,
        ...(entry.context?.length ? { context: entry.context } : {}),
      })
      boundary = index
      lastQuestionIndex = index
    } else if (entry.kind === 'resume') {
      boundary = index
    } else if (entry.kind === 'answer') {
      if (entry.text.trim()) answers.push({ text: entry.text.trim(), at: entry.at, index })
    } else if (entry.kind === 'tool') {
      checks.push({
        id: entry.id,
        name: entry.name,
        target: entry.target,
        status: entry.status,
        note: entry.note,
        ms: entry.ms,
        at: entry.at,
        view: entry.view,
      })
    } else if (entry.kind === 'reverify') {
      reverify = entry.report
    } else if (entry.kind === 'notice') {
      pending.push({
        index,
        notice: {
          id: entry.id,
          ...(entry.code ? { code: entry.code } : {}),
          text: entry.text,
          tone: entry.tone,
          ...(entry.action ? { action: entry.action } : {}),
        },
      })
    }
  })
  // Only notices after the last question or resume still apply.
  for (const item of pending) if (item.index > boundary) notices.push(item.notice)

  for (const tool of live?.tools ?? []) {
    checks.push({
      id: `live:${tool.callId}`,
      name: tool.name,
      target: tool.target,
      status: 'running',
      note: tool.note,
      ms: null,
      at: tool.startedAt,
      view: null,
    })
  }

  const set = new FindingSet()
  const blind = new Map<string, BriefBlind>()
  const undecided: UndecidedAccumulator = new Map()
  const fixes = new Map<string, BriefFix>()
  const coverage = new Map<string, BriefCoverage>()
  let data: BriefData | null = null
  let changes: PostureChange[] = []
  let attribution: Brief['attribution'] = null
  let lastReadAt: string | null = null
  for (const check of checks) {
    if (check.status !== 'done' || !check.view) continue
    fold(set, blind, undecided, check)
    if (STORAGE_READS.has(check.name) && check.at) lastReadAt = later(lastReadAt, check.at)
    const view = check.view
    if (
      DATA_KINDS.has(view.kind) &&
      !(view.kind === 'estate' && !view.buckets?.rows.length) &&
      !(view.kind === 'config' && !view.access)
    ) {
      data = {
        key: check.id,
        kind: view.kind,
        title: check.target,
        view,
        sourceId: check.id,
        at: check.at,
        memory: view.kind === 'estate',
      }
    }
    if (view.kind === 'fix') {
      const key = `${view.bucket}|${view.code}`
      fixes.delete(key)
      fixes.set(key, { key, sourceId: check.id, view, at: check.at })
      for (const item of view.batch ?? []) {
        const batchKey = `${item.bucket}|${item.code}`
        fixes.delete(batchKey)
        fixes.set(batchKey, {
          key: batchKey,
          sourceId: check.id,
          view: {
            ...view,
            bucket: item.bucket,
            code: item.code,
            formats: item.formats,
            impact: item.impact,
            batch: undefined,
          },
          at: check.at,
        })
      }
    }
    if (view.kind === 'survey') {
      changes = view.postureChanges ?? []
      attribution = view.attribution ?? null
      const key = view.providerId ?? view.provider
      const existing = coverage.get(key)
      // A narrowed re-read is useful for the bucket, but it cannot speak for
      // the account. Merge it into an existing account reading; never replace
      // that reading with one bucket's coverage.
      if (!view.scoped) {
        coverage.set(key, {
          provider: view.provider,
          accountBlock: view.account?.pab ?? null,
          capacity: view.capacity ?? null,
          issueTotal: view.issueTotal ?? null,
          visible: view.coverage.visible,
          processed: view.coverage.processed,
          pending: view.coverage.pending ?? 0,
          denied: view.coverage.denied,
          unknown: view.coverage.unknown,
          gone: view.coverage.gone ?? [],
          truncated: view.coverage.truncated,
          at: check.at,
        })
      } else if (existing) {
        const read = new Set(view.buckets.rows.map((row) => String(row[0])))
        coverage.set(key, {
          ...existing,
          processed: Math.min(
            existing.visible,
            existing.processed + Math.max(0, view.coverage.processed),
          ),
          // A narrowed read cannot identify which account-wide pending bucket
          // it covered, so it never reduces the pending count.
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
          at: later(existing.at, check.at),
        })
      }
    }
  }
  set.overlay(issueStatus)

  const all = set.values()
  const order = (a: BriefFinding, b: BriefFinding) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    (a.source === b.source ? 0 : a.source === 'read' ? -1 : 1) ||
    Date.parse(b.at) - Date.parse(a.at) ||
    a.bucket.localeCompare(b.bucket)
  const findings = all.filter((finding) => finding.status === 'open').sort(order)
  const accepted = all.filter((finding) => finding.status === 'accepted').sort(order)

  // A fix stops being shown once the task proved its problem fixed.
  const fixed = new Set(
    [...set.resolved.values()].map((finding) => `${finding.bucket}|${finding.code}`),
  )
  for (const finding of all) fixed.delete(`${finding.bucket}|${finding.code}`)
  const shownFixes = [...fixes.values()].filter((fix) => !fixed.has(fix.key)).reverse()

  const current = checks.filter((check) => {
    const question = questions.at(-1)
    if (!question) return true
    return !question.at || !check.at || Date.parse(check.at) >= Date.parse(question.at)
  })
  const measured = current.filter((check) => check.status !== 'running' && check.ms !== null)
  const durationMs = measured.length
    ? measured.reduce((total, check) => total + (check.ms ?? 0), 0)
    : null

  const known = knownNames(entries)
  const exposure = knownExposure(entries)
  const streamed = live?.text?.trim() ? live.text.trim() : null
  const lastAnswer = answers.at(-1) ?? null
  const verdict = streamed
    ? {
        text: streamed,
        at: live?.startedAt ?? new Date().toISOString(),
        streaming: true,
        stale: false,
        ungrounded: [],
        contradicted: [],
      }
    : lastAnswer
      ? {
          text: lastAnswer.text,
          at: lastAnswer.at,
          streaming: false,
          stale: lastAnswer.index < lastQuestionIndex,
          ungrounded: ungrounded(lastAnswer.text, known),
          contradicted: contradicted(lastAnswer.text, exposure),
        }
      : null

  return {
    verdict,
    findings,
    accepted,
    resolved: [...set.resolved.values()],
    blind: [...blind.values()],
    undecided: [...undecided.values()]
      .map((item) => ({
        code: item.code,
        title: item.title,
        buckets: [...item.buckets].slice(0, 20),
        count: item.buckets.size,
      }))
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)),
    data,
    fixes: shownFixes,
    checks,
    coverage: [...coverage.values()],
    questions,
    changes,
    reverify,
    attribution,
    notices,
    durationMs,
    lastReadAt,
    lastAt: live?.startedAt ? later(lastAt, live.startedAt) : lastAt,
    issueTotal: [...coverage.values()].some((item) => item.issueTotal !== null)
      ? [...coverage.values()].reduce((sum, item) => sum + (item.issueTotal ?? 0), 0)
      : null,
  }
}

/** Text the search index stores for a task's brief. */
export function briefSearchText(
  brief: Brief,
): { entryId: string; kind: string; text: string; at: string }[] {
  const docs: { entryId: string; kind: string; text: string; at: string }[] = []
  for (const finding of [...brief.findings, ...brief.accepted]) {
    docs.push({
      // The source check id travels with the finding so a search hit can load
      // the entry even when it is older than the window's first page.
      entryId: `f:${finding.sourceId}:${finding.key}`,
      kind: 'finding',
      text: [finding.bucket, finding.title, finding.detail].filter(Boolean).join(' · '),
      at: finding.at,
    })
  }
  if (brief.verdict) {
    const latest = brief.checks.reduce<string | null>((at, check) => later(at, check.at), null)
    docs.push({
      entryId: 'verdict',
      kind: 'answer',
      text: brief.verdict.text,
      at: latest ?? brief.verdict.at,
    })
  }
  return docs
}
