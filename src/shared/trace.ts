/**
 * The run as the agent's own trace.
 *
 * This is the one model the window renders. It is not a report schema: every
 * event below is something that actually happened in the durable task (a
 * request, a plan revision, a tool call, a validation, a question or the
 * answer), in the order it happened. Coverage and findings are annotations on
 * that trace, never a second page.
 */
import type {
  AttachmentRef,
  ContextRef,
  IssueRow,
  Live,
  PlanStep,
  ReverifyReport,
  Severity,
  ToolName,
  ToolStatus,
  ToolView,
  UiEntry,
  Usage,
} from './contract'
import { deriveFacts, type ReadState, type RiskFact, type RunFacts, readState } from './facts'
import { buildRun, type RunEvidence, type RunModel, resolveEvidence } from './run'

export type TracePhase =
  | 'planning'
  | 'investigating'
  | 'answering'
  | 'clarifying'
  | 'stopped'
  | 'failed'
  | 'settled'
  | 'empty'

export type TraceEvent =
  | {
      kind: 'request'
      id: string
      at: string
      text: string
      attachments: AttachmentRef[]
      context?: ContextRef[]
    }
  | {
      kind: 'steer'
      id: string
      at: string
      text: string
      attachments: AttachmentRef[]
      context?: ContextRef[]
    }
  | { kind: 'plan'; id: string; at: string; steps: PlanStep[]; note: string | null }
  | {
      kind: 'tool'
      id: string
      at: string
      entryId: string
      name: ToolName
      target: string
      status: ToolStatus
      note: string | null
      args: string | null
      ms: number | null
      evidenceId?: string
      view: ToolView | null
    }
  | { kind: 'reasoning'; id: string; at: string; text: string | null }
  | { kind: 'validation'; id: string; at: string; text: string }
  | {
      kind: 'question'
      id: string
      at: string
      question: string
      options: string[]
      note: string | null
    }
  | { kind: 'answer'; id: string; at: string; text: string; streaming: boolean }
  | {
      kind: 'notice'
      id: string
      at: string
      code?: 'stopped' | 'no_answer' | 'failed' | 'budget' | 'model_missing'
      text: string
      tone: 'info' | 'warn' | 'error'
      action?: 'retry' | 'continue'
    }
  | { kind: 'compaction'; id: string; at: string; text: string }
  | { kind: 'resume'; id: string; at: string }
  | { kind: 'reverify'; id: string; at: string; report: ReverifyReport }

export interface RunTrace {
  events: TraceEvent[]
  question: RunModel['question']
  plan: RunModel['plan']
  clarify: RunModel['clarify']
  answer: RunModel['answer']
  /** Deterministic annotations, not page sections. */
  facts: RunFacts
  coverage: ReadState
  findings: RiskFact[]
  accepted: RiskFact[]
  resolved: RiskFact[]
  evidence: RunEvidence[]
  counts: Record<Severity, number>
  audit: boolean
  phase: TracePhase
  usage: Usage | null
}

/** A task can hold several turns; this is the projection for one of them. */
export interface RunTurn {
  id: string
  question: RunModel['question']
  plan: RunModel['plan']
  answer: RunModel['answer']
  counts: Record<Severity, number>
  checks: number
  at: string
}

export function currentRunEntries(entries: readonly UiEntry[]): UiEntry[] {
  let start = 0
  entries.forEach((entry, index) => {
    if (entry.kind === 'user' && !entry.steer) start = index
  })
  return entries.slice(start)
}

function eventOf(entry: UiEntry): TraceEvent | null {
  switch (entry.kind) {
    case 'user':
      return entry.steer
        ? {
            kind: 'steer',
            id: entry.id,
            at: entry.at,
            text: entry.text,
            attachments: entry.attachments,
            ...(entry.context?.length ? { context: entry.context } : {}),
          }
        : {
            kind: 'request',
            id: entry.id,
            at: entry.at,
            text: entry.text,
            attachments: entry.attachments,
            ...(entry.context?.length ? { context: entry.context } : {}),
          }
    case 'reasoning':
      return { kind: 'reasoning', id: entry.id, at: entry.at, text: entry.text.trim() || null }
    case 'validation':
      return { kind: 'validation', id: entry.id, at: entry.at, text: entry.text }
    case 'answer':
      return {
        kind: 'answer',
        id: entry.id,
        at: entry.at,
        text: entry.text,
        streaming: Boolean(entry.streaming),
      }
    case 'notice':
      return {
        kind: 'notice',
        id: entry.id,
        at: entry.at,
        ...(entry.code ? { code: entry.code } : {}),
        text: entry.text,
        tone: entry.tone,
        ...(entry.action ? { action: entry.action } : {}),
      }
    case 'compaction':
      return { kind: 'compaction', id: entry.id, at: entry.at, text: entry.text }
    case 'resume':
      return { kind: 'resume', id: entry.id, at: entry.at }
    case 'reverify':
      return { kind: 'reverify', id: entry.id, at: entry.at, report: entry.report }
    case 'tool':
      if (entry.name === 'plan' && entry.view?.kind === 'plan')
        return {
          kind: 'plan',
          id: entry.id,
          at: entry.at,
          steps: entry.view.steps,
          note: entry.view.note ?? null,
        }
      if (entry.name === 'ask' && entry.view?.kind === 'question')
        return {
          kind: 'question',
          id: entry.id,
          at: entry.at,
          question: entry.view.question,
          options: entry.view.options,
          note: entry.view.note ?? null,
        }
      return {
        kind: 'tool',
        id: entry.id,
        at: entry.at,
        entryId: entry.id,
        name: entry.name,
        target: entry.target,
        status: entry.status,
        note: entry.note,
        args: entry.args ?? null,
        ms: entry.ms,
        ...(entry.evidenceId ? { evidenceId: entry.evidenceId } : {}),
        view: entry.view,
      }
    default:
      return null
  }
}

function phaseOf(model: RunModel, events: readonly TraceEvent[], live: Live | null): TracePhase {
  const notices = events.filter(
    (event): event is Extract<TraceEvent, { kind: 'notice' }> => event.kind === 'notice',
  )
  if (live) {
    if (live.phase === 'writing' && live.text) return 'answering'
    if (live.phase === 'thinking' && live.tools.length === 0) return 'planning'
    return 'investigating'
  }
  if (model.clarify && !model.answer) return 'clarifying'
  if (notices.some((notice) => notice.code === 'failed' || notice.code === 'no_answer'))
    return 'failed'
  if (notices.some((notice) => notice.code === 'stopped')) return 'stopped'
  if (model.answer) return 'settled'
  return 'empty'
}

export function buildTrace(
  entries: readonly UiEntry[],
  live?: Live | null,
  issueStatus: Record<string, IssueRow['status']> = {},
  usage: Usage | null = null,
): RunTrace {
  const model = buildRun(entries, live ?? null, issueStatus)
  const facts = model.facts
  const events = entries.map(eventOf).filter((event): event is TraceEvent => event !== null)
  return {
    events,
    question: model.question,
    plan: model.plan,
    clarify: model.clarify,
    answer: model.answer,
    facts,
    coverage: readState(facts),
    findings: facts.findings,
    accepted: facts.accepted,
    resolved: facts.resolved,
    evidence: model.evidence,
    counts: model.counts,
    audit: model.audit,
    phase: phaseOf(model, events, live ?? null),
    usage,
  }
}

export { type RunEvidence, resolveEvidence }

/** The plain Markdown saved or copied for a run: the answer, then its trace. */
export function traceMarkdown(trace: RunTrace): string {
  const parts: string[] = []
  if (trace.answer?.text) parts.push(trace.answer.text)
  if (trace.plan) {
    parts.push('## Plan', ...trace.plan.steps.map((step) => `- ${step.status}: ${step.title}`))
  }
  const tools = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: 'tool' }> => event.kind === 'tool',
  )
  if (tools.length) {
    parts.push(
      '## Trace',
      ...tools.map(
        (tool) =>
          `- ${tool.name} · ${tool.target || 'account'} · ${tool.status}${
            tool.note ? ` · ${tool.note}` : ''
          }`,
      ),
    )
  }
  if (trace.findings.length) {
    parts.push(
      '## Findings',
      ...trace.findings.map(
        (finding) =>
          `- ${finding.bucket || 'account'} · ${finding.title} (${finding.severity})${
            finding.source === 'memory' ? ' · remembered' : ''
          }`,
      ),
    )
  }
  if (!trace.coverage.complete) {
    parts.push(
      '## Not checked',
      `- ${trace.coverage.open} open question(s), ${trace.coverage.blocked} blocked.`,
    )
  }
  return parts.join('\n\n')
}

export function turnsOf(
  entries: readonly UiEntry[],
  issueStatus: Record<string, IssueRow['status']> = {},
): RunTurn[] {
  const starts = entries
    .map((entry, index) => (entry.kind === 'user' && !entry.steer ? index : -1))
    .filter((index) => index >= 0)
  if (!starts.length || starts[0]! > 0) starts.unshift(0)
  const turns: RunTurn[] = []
  for (let at = 0; at < starts.length; at += 1) {
    const start = starts[at]!
    const end = starts[at + 1] ?? entries.length
    const slice = entries.slice(start, end)
    if (!slice.length) continue
    const model = buildRun(slice, null, issueStatus)
    if (!model.question && !model.answer && !model.facts.checks.length) continue
    turns.push({
      id: model.question?.id ?? `turn:${slice[0]!.id}`,
      question: model.question,
      plan: model.plan,
      answer: model.answer,
      counts: model.counts,
      checks: model.facts.checks.length,
      at: model.question?.at ?? model.answer?.at ?? slice[0]!.at,
    })
  }
  return turns
}

export { deriveFacts }
