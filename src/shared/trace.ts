/**
 * The run as the agent's trace: the one projection the window renders.
 *
 * Input is the task's durable entries plus the live slot; output is the current
 * run (the latest request or scripted check) and compact summaries of earlier
 * runs. Every row is something that happened, in order. Coverage comes from the
 * ledger; findings come from the rules' readings; the answer is the model's own
 * prose, checked for structure only. Shared by the window and the main process
 * (search indexes the same projection).
 */
import type {
  AttachmentRef,
  ConfigFinding,
  ContextRef,
  IssueRow,
  Live,
  NoticeCode,
  Observation,
  PlanStep,
  ReverifyReport,
  Severity,
  ToolName,
  ToolStatus,
  ToolView,
  UiEntry,
  Usage,
} from './contract'
import {
  type CallFact,
  type EvidenceRef,
  foldLedger,
  type Ledger,
  type ReadState,
  readState,
  runRanges,
} from './ledger'
import { type AnswerCheck, checkAnswer, resolveCitation } from './validate'

export type TracePhase =
  | 'planning'
  | 'investigating'
  | 'answering'
  | 'clarifying'
  | 'stopped'
  | 'failed'
  | 'settled'
  | 'empty'

/** One row of the trace. Plan revisions and the answer are not rows. */
export type TraceItem =
  | {
      kind: 'reasoning'
      id: string
      at: string
      status: ToolStatus
      text: string | null
      live: boolean
    }
  | {
      kind: 'tool'
      id: string
      /** The durable entry id, used to reveal the row from a citation. */
      entryId?: string
      at: string
      status: ToolStatus
      name: ToolName
      target: string
      note: string | null
      args: string | null
      durationMs: number | null
      evidenceId?: string
      view: ToolView | null
      assessed?: { opened: number; resolved: number; recurred: number }
      live: boolean
    }
  | { kind: 'steer'; id: string; at: string; text: string }
  | { kind: 'validation'; id: string; at: string; text: string }
  | { kind: 'compaction'; id: string; at: string; text: string }
  | { kind: 'resume'; id: string; at: string }
  | { kind: 'reverify'; id: string; at: string; report: ReverifyReport }

export interface RiskFact {
  key: string
  provider: string | null
  bucket: string
  code: string
  title: string
  detail: string | null
  severity: Severity
  control: string | null
  /** The estate Issue behind the finding; null for a review advisory. */
  issueId: string | null
  status: 'open' | 'accepted'
  /** `memory`: last read before this run, by `estate` or for a bucket this survey did not read. */
  source: 'read' | 'memory'
  readAt: string
  sourceId: string
  at: string
}

export interface NoticeFact {
  id: string
  code?: NoticeCode
  text: string
  tone: 'info' | 'warn' | 'error'
  action?: 'retry' | 'continue'
}

export interface RunPlan {
  id: string
  steps: PlanStep[]
  note: string | null
}

export interface RunAnswer {
  /** The answer entry, so a search hit can find it. */
  id: string
  text: string
  at: string
  streaming: boolean
  /** Written by a scripted check from its own calls, not by a model. */
  synthesized: boolean
  check: AnswerCheck
}

export interface RunRequest {
  id: string
  text: string
  at: string
  attachments: AttachmentRef[]
  context?: ContextRef[]
}

export interface RunTrace {
  ledger: Ledger
  read: ReadState
  request: RunRequest | null
  /** A scripted check or re-check: there is no request to show. */
  scripted: 'check' | 'recheck' | null
  plan: RunPlan | null
  clarify: { id: string; question: string; options: string[]; note: string | null } | null
  answer: RunAnswer | null
  items: TraceItem[]
  calls: number
  durationMs: number | null
  findings: RiskFact[]
  accepted: RiskFact[]
  /** Findings the task saw open and a later reading proved fixed. */
  resolved: RiskFact[]
  counts: Record<Severity, number>
  notices: NoticeFact[]
  gone: string[]
  /** The answer rests on remembered readings: when the newest of them was taken. */
  memoryAt: string | null
  /** The baseline of a change plan in the run, for a run that read nothing else. */
  planAt: string | null
  phase: TracePhase
  usage: Usage | null
}

export interface RunSummary {
  id: string
  answerId: string | null
  request: string | null
  scripted: 'check' | 'recheck' | null
  answer: string | null
  calls: number
  counts: Record<Severity, number>
  at: string
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** Findings keyed by account, bucket and rule; an unknown account matches any. */
class FindingSet {
  private readonly map = new Map<string, RiskFact>()
  readonly resolved = new Map<string, RiskFact>()

  private find(provider: string | null, bucket: string, code: string): string | undefined {
    const exact = `${provider ?? '*'}|${bucket}|${code}`
    if (this.map.has(exact)) return exact
    const suffix = `|${bucket}|${code}`
    for (const key of this.map.keys())
      if (key.endsWith(suffix) && (provider === null || key.startsWith('*|'))) return key
    return undefined
  }

  set(finding: RiskFact): void {
    const existing = this.find(finding.provider, finding.bucket, finding.code)
    const previous = existing ? this.map.get(existing) : undefined
    if (existing) this.map.delete(existing)
    this.resolved.delete(finding.key)
    const provider = finding.provider ?? previous?.provider ?? null
    this.map.set(`${provider ?? '*'}|${finding.bucket}|${finding.code}`, {
      ...finding,
      provider,
      issueId: finding.issueId ?? previous?.issueId ?? null,
      detail: finding.detail ?? previous?.detail ?? null,
    })
  }

  clear(observation: Observation): void {
    const existing = this.find(observation.provider, observation.bucket, observation.code)
    if (!existing) return
    const finding = this.map.get(existing)!
    this.map.delete(existing)
    if (finding.issueId) this.resolved.set(finding.key, finding)
  }

  /** Drop Issue findings of an account (optionally one bucket) that a full list leaves out. */
  replaceIssues(provider: string | null, bucket: string | null, keep: Set<string>): void {
    for (const [key, finding] of [...this.map]) {
      if (!finding.issueId || keep.has(finding.issueId)) continue
      if (provider && finding.provider && finding.provider !== provider) continue
      if (bucket && finding.bucket !== bucket) continue
      this.map.delete(key)
      if (finding.source === 'read') this.resolved.set(finding.key, finding)
    }
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

  values(): RiskFact[] {
    return [...this.map.values()]
  }
}

function issueFinding(issue: IssueRow, check: CallFact, source: 'read' | 'memory'): RiskFact {
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
    sourceId: check.id,
    at: check.at,
  }
}

function reviewFinding(
  finding: ConfigFinding,
  bucket: string,
  provider: string | null,
  check: CallFact,
  issue?: IssueRow,
): RiskFact {
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
    sourceId: check.id,
    at: check.at,
  }
}

/**
 * Findings are current state, folded in call order: a survey replaces what the
 * run knew about its account, a review replaces the rules it read, a reading
 * that proves a rule clean removes its finding, and the estate's current Issue
 * status (accepted by the user, resolved elsewhere) is laid over the top.
 */
function foldFindings(checks: readonly CallFact[], status: Record<string, IssueRow['status']>) {
  const set = new FindingSet()
  for (const check of checks) {
    const view = check.view
    if (check.status !== 'done' || !view) continue
    if (view.kind === 'survey') {
      const provider = view.providerId ?? view.issues[0]?.provider ?? null
      for (const observation of view.observations ?? [])
        if (!observation.verdict) set.clear(observation)
      // A complete Issue list is the account's whole open list; a list cut short says nothing.
      const open = view.issues.filter((issue) => issue.status === 'open').length
      if (view.issueTotal === undefined || open >= view.issueTotal)
        set.replaceIssues(provider, null, new Set(view.issues.map((issue) => issue.id)))
      const read = new Set(view.buckets.rows.map((row) => String(row[0])))
      if (view.accountRead) read.add('')
      for (const issue of view.issues)
        set.set(issueFinding(issue, check, read.has(issue.bucket) ? 'read' : 'memory'))
    } else if (view.kind === 'estate') {
      set.replaceIssues(
        view.providerId ?? null,
        view.bucket ?? null,
        new Set(view.issues.map((issue) => issue.id)),
      )
      for (const issue of view.issues) set.set(issueFinding(issue, check, 'memory'))
    } else if (view.kind === 'config') {
      for (const observation of view.observations ?? [])
        if (!observation.verdict) set.clear(observation)
      for (const finding of view.findings) {
        if (finding.severity === 'ok' || finding.severity === 'blind') continue
        const issue = view.issues?.find(
          (item) => item.bucket === view.bucket && item.code === finding.code,
        )
        set.set(reviewFinding(finding, view.bucket, view.providerId ?? null, check, issue))
      }
    }
  }
  set.overlay(status)
  const order = (a: RiskFact, b: RiskFact) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    (a.source === b.source ? 0 : a.source === 'read' ? -1 : 1) ||
    Date.parse(b.at) - Date.parse(a.at) ||
    a.bucket.localeCompare(b.bucket)
  const all = set.values()
  return {
    open: all.filter((finding) => finding.status === 'open').sort(order),
    accepted: all.filter((finding) => finding.status === 'accepted').sort(order),
    resolved: [...set.resolved.values()],
  }
}

function itemsOf(run: readonly UiEntry[], live: Live | null): TraceItem[] {
  const items: TraceItem[] = []
  const seen = new Set<string>()
  for (const entry of run) {
    if (entry.kind === 'reasoning')
      items.push({
        kind: 'reasoning',
        id: entry.id,
        at: entry.at,
        status: 'done',
        text: entry.text.trim() || null,
        live: false,
      })
    else if (entry.kind === 'steer')
      items.push({ kind: 'steer', id: entry.id, at: entry.at, text: entry.text })
    else if (entry.kind === 'validation')
      items.push({ kind: 'validation', id: entry.id, at: entry.at, text: entry.text })
    else if (entry.kind === 'compaction')
      items.push({ kind: 'compaction', id: entry.id, at: entry.at, text: entry.text })
    else if (entry.kind === 'resume') items.push({ kind: 'resume', id: entry.id, at: entry.at })
    else if (entry.kind === 'reverify')
      items.push({ kind: 'reverify', id: entry.id, at: entry.at, report: entry.report })
    else if (entry.kind === 'tool' && entry.name !== 'plan' && entry.name !== 'ask') {
      if (entry.callId) seen.add(entry.callId)
      if (entry.evidenceId) seen.add(entry.evidenceId)
      items.push({
        kind: 'tool',
        id: entry.callId ?? entry.id,
        entryId: entry.id,
        at: entry.at,
        status: entry.status,
        name: entry.name,
        target: entry.target,
        note: entry.note,
        args: entry.args ?? null,
        durationMs: entry.ms,
        ...(entry.evidenceId ? { evidenceId: entry.evidenceId } : {}),
        view: entry.view,
        ...(entry.assessed ? { assessed: entry.assessed } : {}),
        live: false,
      })
    }
  }
  if (!live) return items
  const lastReasoning = items.findLast((item) => item.kind === 'reasoning')
  if (live.reasoning && lastReasoning?.text !== live.reasoning.summary)
    items.push({
      kind: 'reasoning',
      id: `live:reasoning:${live.reasoning.startedAt}`,
      at: live.reasoning.startedAt,
      status: live.phase === 'reasoning' || live.phase === 'thinking' ? 'running' : 'done',
      text: live.reasoning.summary,
      live: true,
    })
  else if (
    (live.phase === 'thinking' || live.phase === 'reasoning') &&
    !items.some((item) => item.kind === 'reasoning')
  )
    items.push({
      kind: 'reasoning',
      id: `live:thinking:${live.startedAt}`,
      at: live.startedAt,
      status: 'running',
      text: null,
      live: true,
    })
  for (const tool of live.tools) {
    if (tool.name === 'plan' || tool.name === 'ask' || tool.name === 'skill') continue
    if (tool.callId && seen.has(tool.callId)) continue
    items.push({
      kind: 'tool',
      id: `live:${tool.callId || tool.name}:${tool.startedAt}`,
      at: tool.startedAt,
      status: tool.status,
      name: tool.name,
      target: tool.target,
      note: tool.note,
      args: tool.args ?? null,
      durationMs: null,
      view: null,
      live: true,
    })
  }
  return items
}

function callsOf(entries: readonly UiEntry[]): CallFact[] {
  return entries.flatMap((entry) =>
    entry.kind === 'tool' && entry.name !== 'plan' && entry.name !== 'ask' && entry.name !== 'skill'
      ? [
          {
            id: entry.id,
            name: entry.name,
            target: entry.target,
            status: entry.status,
            note: entry.note,
            args: entry.args ?? null,
            ms: entry.ms,
            at: entry.at,
            view: entry.view,
          },
        ]
      : [],
  )
}

function phaseOf(trace: Pick<RunTrace, 'clarify' | 'answer' | 'notices'>, live: Live | null) {
  if (live) {
    if (live.phase === 'writing' && live.text) return 'answering'
    if (live.phase === 'thinking' && live.tools.length === 0) return 'planning'
    return 'investigating'
  }
  if (trace.clarify && !trace.answer) return 'clarifying'
  if (trace.notices.some((notice) => notice.code === 'failed' || notice.code === 'no_answer'))
    return 'failed'
  if (trace.notices.some((notice) => notice.code === 'stopped')) return 'stopped'
  return trace.answer ? 'settled' : 'empty'
}

function countsOf(findings: readonly RiskFact[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}

export function buildTrace(
  entries: readonly UiEntry[],
  live: Live | null = null,
  issueStatus: Record<string, IssueRow['status']> = {},
  usage: Usage | null = null,
): RunTrace {
  const ledger = foldLedger(entries, live)
  const run = entries.slice(Math.max(0, ledger.start))
  const first = run[0]
  const request: RunRequest | null =
    first?.kind === 'user'
      ? {
          id: first.id,
          text: first.text,
          at: first.at,
          attachments: first.attachments,
          ...(first.context?.length ? { context: first.context } : {}),
        }
      : null

  let plan: RunPlan | null = null
  let clarify: RunTrace['clarify'] = null
  let answerEntry: Extract<UiEntry, { kind: 'answer' }> | null = null
  let boundary = 0
  const notices: { index: number; notice: NoticeFact }[] = []
  run.forEach((entry, index) => {
    if (entry.kind === 'resume') boundary = index
    if (entry.kind === 'answer' && entry.text.trim()) answerEntry = entry
    if (entry.kind === 'notice')
      notices.push({
        index,
        notice: {
          id: entry.id,
          ...(entry.code ? { code: entry.code } : {}),
          text: entry.text,
          tone: entry.tone,
          ...(entry.action ? { action: entry.action } : {}),
        },
      })
    if (entry.kind !== 'tool' || entry.status !== 'done') return
    if (entry.view?.kind === 'plan')
      plan = { id: entry.id, steps: entry.view.steps, note: entry.view.note ?? null }
    if (entry.view?.kind === 'question')
      clarify = {
        id: entry.id,
        question: entry.view.question,
        options: entry.view.options,
        note: entry.view.note ?? null,
      }
  })

  const streamed = live?.text?.trim() || null
  const settled = answerEntry as Extract<UiEntry, { kind: 'answer' }> | null
  const text = streamed ?? settled?.text.trim() ?? null
  const answer: RunAnswer | null = text
    ? {
        id: streamed ? 'live' : (settled?.id ?? ''),
        text,
        at: streamed ? (live?.startedAt ?? '') : (settled?.at ?? ''),
        streaming: Boolean(streamed),
        synthesized: !streamed && settled?.source === 'check',
        check: streamed
          ? { ungrounded: [], unresolved: [], uncited: [] }
          : checkAnswer(text, ledger),
      }
    : null

  const findings = foldFindings(ledger.checks, issueStatus)
  // The resolved fold is task memory: an earlier run saw it open, a later reading proved it fixed.
  const current = new Set([...findings.open, ...findings.accepted].map((finding) => finding.key))
  const resolved = foldFindings(callsOf(entries), issueStatus).resolved.filter(
    (finding) => !current.has(finding.key),
  )

  const items = itemsOf(run, live)
  const tools = items.filter(
    (item): item is Extract<TraceItem, { kind: 'tool' }> => item.kind === 'tool',
  )
  const durations = tools.flatMap((item) => (item.durationMs !== null ? [item.durationMs] : []))
  const all = [...findings.open, ...findings.accepted]
  const memory = all.length > 0 && all.every((finding) => finding.source === 'memory')
  const estate = ledger.checks.findLast(
    (check) => check.status === 'done' && check.view?.kind === 'estate',
  )
  const planView = ledger.checks.find((check) => check.view?.kind === 'change')?.view

  const trace: RunTrace = {
    ledger,
    read: readState(ledger),
    request,
    scripted: ledger.trigger === 'check' || ledger.trigger === 'recheck' ? ledger.trigger : null,
    plan,
    clarify,
    answer,
    items,
    // A method card is documentation, not a storage call.
    calls: tools.filter((item) => item.name !== 'skill').length,
    durationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
    findings: findings.open,
    accepted: findings.accepted,
    resolved,
    counts: countsOf(findings.open),
    notices: notices.filter((item) => item.index >= boundary).map((item) => item.notice),
    gone: ledger.coverage.flatMap((item) => item.gone),
    memoryAt: memory
      ? (all
          .map((finding) => finding.readAt)
          .sort()
          .at(-1) ?? null)
      : estate && !ledger.lastReadAt
        ? estate.at
        : null,
    planAt:
      planView?.kind === 'change' && planView.plan?.baseline ? planView.plan.baseline.at : null,
    phase: 'empty',
    usage,
  }
  trace.phase = phaseOf(trace, live)
  return trace
}

export function resolveEvidence(trace: RunTrace, id: string | undefined): EvidenceRef | undefined {
  return resolveCitation(trace.ledger.evidence, id)
}

/** Earlier runs of the task, oldest first, without the current one. */
export function earlierRuns(entries: readonly UiEntry[]): RunSummary[] {
  const ranges = runRanges(entries)
  return ranges.slice(0, -1).flatMap(([start, end]) => {
    const slice = entries.slice(start, end)
    const first = slice[0]
    const answer = slice.findLast(
      (entry): entry is Extract<UiEntry, { kind: 'answer' }> => entry.kind === 'answer',
    )
    const calls = slice.filter(
      (entry) =>
        entry.kind === 'tool' &&
        entry.name !== 'plan' &&
        entry.name !== 'ask' &&
        entry.name !== 'skill',
    ).length
    if (!first || (first.kind !== 'user' && first.kind !== 'check' && !answer && !calls)) return []
    return [
      {
        id: first.id,
        answerId: answer?.id ?? null,
        request: first.kind === 'user' ? first.text : null,
        scripted: first.kind === 'check' ? first.mode : null,
        answer: answer?.text ?? null,
        calls,
        counts: countsOf(foldFindings(callsOf(slice), {}).open),
        at: first.at || answer?.at || '',
      },
    ]
  })
}

/** The plain Markdown saved for a run: the answer, then its trace and evidence. */
export function traceMarkdown(trace: RunTrace): string {
  const parts: string[] = []
  if (trace.answer?.text) parts.push(trace.answer.text)
  if (trace.plan)
    parts.push('## Plan', ...trace.plan.steps.map((step) => `- ${step.status}: ${step.title}`))
  const tools = trace.items.filter(
    (item): item is Extract<TraceItem, { kind: 'tool' }> => item.kind === 'tool',
  )
  if (tools.length)
    parts.push(
      '## Trace',
      ...tools.map(
        (tool) =>
          `- ${tool.name} · ${tool.target || 'account'} · ${tool.status}${tool.note ? ` · ${tool.note}` : ''}`,
      ),
    )
  if (trace.findings.length)
    parts.push(
      '## Findings',
      ...trace.findings.map(
        (finding) =>
          `- ${finding.bucket || 'account'} · ${finding.title} (${finding.severity})${
            finding.source === 'memory' ? ' · remembered' : ''
          }`,
      ),
    )
  if (!trace.read.complete && trace.read.open > 0)
    parts.push(
      '## Not checked',
      `- ${trace.read.open} open question(s), ${trace.read.blocked} blocked.`,
    )
  return parts.join('\n\n')
}

/** Rows the search index stores for a task: the request, the answer and each finding. */
export function searchRows(
  entries: readonly UiEntry[],
): { entryId: string; kind: string; text: string; at: string }[] {
  const rows: { entryId: string; kind: string; text: string; at: string }[] = []
  for (const entry of entries)
    if (entry.kind === 'user' && entry.text.trim())
      rows.push({ entryId: entry.id, kind: 'user', text: entry.text, at: entry.at })
  // Findings of every run in the task: a search for a risk finds the task that saw it.
  const findings = foldFindings(callsOf(entries), {})
  for (const finding of [...findings.open, ...findings.accepted])
    rows.push({
      // The source check id travels with the finding, so a hit can load it.
      entryId: `f:${finding.sourceId}:${finding.key}`,
      kind: 'finding',
      text: [finding.bucket, finding.title, finding.detail].filter(Boolean).join(' · '),
      at: finding.at,
    })
  // Every run's answer: a hit on an earlier run opens that run.
  for (const [start, end] of runRanges(entries)) {
    const slice = entries.slice(start, end)
    const last = slice.findLast(
      (entry): entry is Extract<UiEntry, { kind: 'answer' }> => entry.kind === 'answer',
    )
    if (!last?.text.trim()) continue
    const read = foldLedger(slice).lastReadAt
    rows.push({
      entryId: `answer:${last.id}`,
      kind: 'answer',
      text: last.text,
      at: read ?? last.at,
    })
  }
  return rows
}
