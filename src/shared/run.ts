/**
 * Projection of a durable task into the one run the window renders.
 *
 * The agent's final prose is the answer. Tool results are the evidence: a
 * result either exists or it does not, and the answer cites its evidence id.
 */

import type {
  IssueRow,
  Live,
  PlanStep,
  Severity,
  ToolName,
  ToolStatus,
  ToolView,
  UiEntry,
} from './contract'
import { deriveFacts, type RiskFact, type RunFacts } from './facts'

export interface RunPlan {
  id: string
  at: string
  steps: PlanStep[]
  note: string | null
}

export interface RunAnswer {
  id: string
  at: string
  text: string | null
  stale: boolean
  synthesized: boolean
  /** Evidence ids in prose that did not resolve to a tool view. */
  unresolvedCitations: number
  ungrounded: string[]
  contradicted: string[]
}

export interface RunClarify {
  id: string
  at: string
  question: string
  options: string[]
  note: string | null
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
  clarify: RunClarify | null
  answer: RunAnswer | null
  facts: RunFacts
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

function citationIds(text: string): string[] {
  return [...text.matchAll(/#ev-([^)\s"'<>]+)/g)].map((match) => decodeURIComponent(match[1]!))
}

/** Evidence ids cited in prose that do not resolve. */
function badCitations(text: string, evidence: readonly RunEvidence[]): number {
  let count = 0
  for (const id of citationIds(text)) if (!resolveEvidence(evidence, id)?.view) count += 1
  return count
}

function answerOf(
  facts: RunFacts,
  evidence: readonly RunEvidence[],
  audit: boolean,
): RunAnswer | null {
  const answer = facts.answer
  if (!answer) return null
  const text = answer.text.trim() || null
  return {
    id: `answer:${answer.at}`,
    at: answer.at,
    text,
    stale: answer.stale,
    synthesized: audit,
    unresolvedCitations: text ? badCitations(text, evidence) : 0,
    ungrounded: answer.ungrounded,
    contradicted: answer.contradicted,
  }
}

export function currentRunEntries(entries: readonly UiEntry[]): UiEntry[] {
  let start = 0
  entries.forEach((entry, index) => {
    if (entry.kind === 'user') start = index
  })
  return entries.slice(start)
}

export function buildRun(
  entries: readonly UiEntry[],
  live?: Live | null,
  issueStatus: Record<string, IssueRow['status']> = {},
): RunModel {
  const facts = deriveFacts(entries, live ?? null, issueStatus)
  const evidence: RunEvidence[] = entries
    .filter((entry): entry is Extract<UiEntry, { kind: 'tool' }> => entry.kind === 'tool')
    .map(evidenceOf)
  let lastQuestionIndex = -1
  let question: RunModel['question'] = null
  entries.forEach((entry, index) => {
    if (entry.kind === 'user') {
      lastQuestionIndex = index
      question = { id: entry.id, text: entry.text, at: entry.at }
    }
  })

  let plan: RunPlan | null = null
  entries.forEach((entry, index) => {
    if (entry.kind !== 'tool' || entry.status !== 'done' || entry.view?.kind !== 'plan') return
    if (index > lastQuestionIndex)
      plan = {
        id: entry.id,
        at: entry.at,
        steps: entry.view.steps,
        note: entry.view.note ?? null,
      }
  })

  let clarify: RunClarify | null = null
  entries.forEach((entry, index) => {
    if (
      entry.kind !== 'tool' ||
      entry.name !== 'ask' ||
      entry.status !== 'done' ||
      entry.view?.kind !== 'question' ||
      index < lastQuestionIndex
    )
      return
    clarify = {
      id: entry.id,
      at: entry.at,
      question: entry.view.question,
      options: entry.view.options,
      note: entry.view.note ?? null,
    }
  })

  const audit = facts.questions.length === 0 && facts.checks.length > 0
  const answer = answerOf(facts, evidence, audit)

  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 }
  for (const finding of facts.findings) counts[finding.severity] += 1

  return { question, plan, clarify, answer, facts, evidence, counts, audit }
}

export interface RunTurn {
  id: string
  question: RunModel['question']
  plan: RunPlan | null
  answer: RunAnswer | null
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

export type { RiskFact }
