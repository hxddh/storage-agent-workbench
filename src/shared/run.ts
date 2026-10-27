/**
 * The agent-native run projection.
 *
 * A run is the durable task plus the agent's own plan, the answer blocks it
 * composed, and the evidence those blocks point at. The deterministic brief is
 * still here: findings, coverage, blind reads and checks are facts, not prose.
 * The report is composition; it cannot invent a table or a number.
 */

import { type BriefFinding, type Brief as BriefModel, buildBrief } from './brief'
import type {
  IssueRow,
  Live,
  PlanStep,
  ReportBlock,
  Severity,
  ToolName,
  ToolStatus,
  ToolView,
  UiEntry,
} from './contract'
import { contradicted, knownExposure, knownNames, ungrounded } from './grounding'

export interface RunPlan {
  id: string
  at: string
  steps: PlanStep[]
  note: string | null
}

export interface RunReport {
  id: string
  at: string
  title: string | null
  blocks: ReportBlock[]
  stale: boolean
  synthesized: boolean
  /** Blocks whose evidence id or view did not resolve; they are omitted. */
  unresolved: number
  ungrounded: string[]
  contradicted: string[]
}

export interface RunEvidence {
  id: string
  /** The UiEntry id, for revealing the matching check. */
  entryId: string
  aliases: string[]
  name: ToolName
  target: string
  at: string
  status: ToolStatus
  view: ToolView | null
}

export interface RunModel {
  question: { id: string; text: string; at: string } | null
  plan: RunPlan | null
  report: RunReport | null
  brief: BriefModel
  evidence: RunEvidence[]
  counts: Record<Severity, number>
  audit: boolean
}

function evidenceOf(entry: Extract<UiEntry, { kind: 'tool' }>): RunEvidence {
  const id = entry.evidenceId ?? entry.callId ?? entry.id
  const aliases = [
    ...new Set([id, entry.evidenceId, entry.callId, entry.id].filter(Boolean) as string[]),
  ]
  return {
    id,
    entryId: entry.id,
    aliases,
    name: entry.name,
    target: entry.target,
    at: entry.at,
    status: entry.status,
    view: entry.view,
  }
}

export function resolveEvidence(
  evidence: readonly RunEvidence[],
  id: string | undefined,
): RunEvidence | undefined {
  if (!id) return undefined
  return evidence.find((item) => item.aliases.includes(id))
}

function hasTable(view: ToolView | null | undefined): boolean {
  return Boolean(
    view &&
      (view.kind === 'survey' ||
        view.kind === 'buckets' ||
        view.kind === 'objects' ||
        view.kind === 'estate' ||
        view.kind === 'query' ||
        (view.kind === 'config' && Boolean(view.access)) ||
        view.kind === 'object'),
  )
}

function validBlock(block: ReportBlock, evidence: readonly RunEvidence[]): boolean {
  if (
    block.kind === 'summary' ||
    block.kind === 'callout' ||
    block.kind === 'markdown' ||
    block.kind === 'findings'
  )
    return true
  const first = block.evidence[0]
  if (block.kind === 'compare')
    return (
      block.evidence.length >= 2 &&
      block.evidence.every((id) => Boolean(resolveEvidence(evidence, id)?.view))
    )
  const source = resolveEvidence(evidence, first)
  if (!source?.view) return false
  if (block.kind === 'table') return hasTable(source.view)
  if (block.kind === 'timeline')
    return Boolean(
      source.view.kind === 'estate' && source.view.history ? true : source.view.kind === 'query',
    )
  if (block.kind === 'plan') return source.view.kind === 'fix' && Boolean(source.view.plan)
  if (block.kind === 'code') return source.view.kind === 'query'
  return false
}

function textOfBlocks(blocks: readonly ReportBlock[]): string {
  return blocks
    .filter(
      (block) => block.kind === 'summary' || block.kind === 'callout' || block.kind === 'markdown',
    )
    .map((block) =>
      block.kind === 'summary' || block.kind === 'callout' || block.kind === 'markdown'
        ? block.text
        : '',
    )
    .join('\n')
}

function normalize(
  report: Extract<ToolView, { kind: 'report' }>,
  id: string,
  at: string,
  stale: boolean,
  synthesized: boolean,
  evidence: readonly RunEvidence[],
  known: ReadonlySet<string>,
  exposure: ReadonlyMap<string, boolean>,
  previous: RunReport | null,
): RunReport {
  const blocks: ReportBlock[] = []
  let unresolved = 0
  for (const block of report.blocks) {
    if (validBlock(block, evidence)) blocks.push(block)
    else unresolved += 1
  }
  const text = textOfBlocks(blocks)
  const names = text ? ungrounded(text, known) : []
  const wrong = text ? contradicted(text, exposure) : []
  const merged = report.append && previous ? [...previous.blocks, ...blocks] : blocks
  return {
    id,
    at,
    title: report.title ?? previous?.title ?? null,
    blocks: merged,
    stale,
    synthesized,
    unresolved,
    ungrounded: names,
    contradicted: wrong,
  }
}

function synthesize(brief: BriefModel, entries: readonly UiEntry[]): RunReport | null {
  if (!brief.verdict?.text && !brief.findings.length && !brief.data) return null
  const blocks: ReportBlock[] = []
  if (brief.verdict?.text) blocks.push({ kind: 'summary', text: brief.verdict.text, evidence: [] })
  const dataCheck = entries.findLast(
    (entry) => entry.kind === 'tool' && entry.id === brief.data?.sourceId,
  )
  const dataEvidence = dataCheck?.kind === 'tool' ? evidenceOf(dataCheck) : null
  if (dataEvidence && brief.data?.view) {
    if (
      brief.data.view.kind === 'survey' ||
      brief.data.view.kind === 'buckets' ||
      brief.data.view.kind === 'objects'
    )
      blocks.push({ kind: 'table', evidence: [dataEvidence.id], limit: 8 })
    else if (brief.data.view.kind === 'query')
      blocks.push(
        { kind: 'table', evidence: [dataEvidence.id], limit: 8 },
        { kind: 'code', evidence: [dataEvidence.id] },
      )
  }
  if (brief.findings.length) blocks.push({ kind: 'findings', title: 'Open findings', limit: 5 })
  const fix = brief.fixes[0]
  if (fix) {
    const fixEvidence = entries.findLast(
      (entry) => entry.kind === 'tool' && entry.id === fix.sourceId,
    )
    if (fixEvidence?.kind === 'tool' && fix.view.plan)
      blocks.push({ kind: 'plan', evidence: [evidenceOf(fixEvidence).id] })
  }
  if (!blocks.length) return null
  return {
    id: `audit:${brief.lastReadAt ?? 'answer'}`,
    at: brief.verdict?.at ?? brief.lastReadAt ?? '',
    title: null,
    blocks,
    stale: false,
    synthesized: true,
    unresolved: 0,
    ungrounded: brief.verdict?.ungrounded ?? [],
    contradicted: brief.verdict?.contradicted ?? [],
  }
}

export function buildRun(
  entries: readonly UiEntry[],
  live?: Live | null,
  issueStatus: Record<string, IssueRow['status']> = {},
): RunModel {
  const brief = buildBrief(entries, live ?? null, issueStatus)
  const evidence: RunEvidence[] = entries
    .filter((entry): entry is Extract<UiEntry, { kind: 'tool' }> => entry.kind === 'tool')
    .map(evidenceOf)
  const known = knownNames(entries)
  const exposure = knownExposure(entries)

  let lastQuestionIndex = -1
  let question: RunModel['question'] = null
  entries.forEach((entry, index) => {
    if (entry.kind === 'user') {
      lastQuestionIndex = index
      question = { id: entry.id, text: entry.text, at: entry.at }
    }
  })

  let plan: RunPlan | null = null
  let report: RunReport | null = null
  entries.forEach((entry, index) => {
    if (entry.kind !== 'tool' || entry.status !== 'done' || !entry.view) return
    if (entry.view.kind === 'plan' && index > lastQuestionIndex) {
      plan = {
        id: entry.id,
        at: entry.at,
        steps: entry.view.steps,
        note: entry.view.note ?? null,
      }
    }
    if (entry.view.kind === 'report') {
      report = normalize(
        entry.view,
        entry.id,
        entry.at,
        index < lastQuestionIndex,
        false,
        evidence,
        known,
        exposure,
        report,
      )
    }
  })

  const audit = brief.questions.length === 0 && brief.checks.length > 0
  if (!report && audit) report = synthesize(brief, entries)

  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 }
  for (const finding of brief.findings) counts[finding.severity] += 1

  return { question, plan, report, brief, evidence, counts, audit }
}

export interface RunTurn {
  id: string
  question: RunModel['question']
  plan: RunPlan | null
  report: RunReport | null
  counts: Record<Severity, number>
  checks: number
  at: string
}

/**
 * A task can hold several turns. The page keeps the latest expanded and offers
 * earlier turns as a compact history; this is a projection, not a second log.
 */
export function turnsOf(
  entries: readonly UiEntry[],
  issueStatus: Record<string, IssueRow['status']> = {},
): RunTurn[] {
  const starts = entries
    .map((entry, index) => (entry.kind === 'user' ? index : -1))
    .filter((index) => index >= 0)
  // A deterministic check has no user entry. If a later follow-up starts a
  // model turn, the check still belongs at the top of the history.
  if (!starts.length || starts[0]! > 0) starts.unshift(0)
  const turns: RunTurn[] = []
  for (let at = 0; at < starts.length; at += 1) {
    const start = starts[at]!
    const end = starts[at + 1] ?? entries.length
    const slice = entries.slice(start, end)
    if (!slice.length) continue
    const model = buildRun(slice, null, issueStatus)
    if (!model.question && !model.report && !model.brief.checks.length) continue
    turns.push({
      id: model.question?.id ?? `turn:${slice[0]!.id}`,
      question: model.question,
      plan: model.plan,
      report: model.report,
      counts: model.counts,
      checks: model.brief.checks.length,
      at: model.question?.at ?? model.report?.at ?? slice[0]!.at,
    })
  }
  return turns
}

export function reportSearchText(run: RunModel): string {
  if (!run.report) return ''
  return [
    run.report.title,
    ...run.report.blocks.flatMap((block) => {
      if (block.kind === 'summary' || block.kind === 'callout' || block.kind === 'markdown')
        return [block.text]
      return []
    }),
  ]
    .filter(Boolean)
    .join('\n')
}

export type { BriefFinding }
