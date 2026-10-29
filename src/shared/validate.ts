/**
 * Answer validation: structure, never wording.
 *
 * Three checks, all language-neutral, shared by the agent's one correction and
 * the window's marks:
 *
 * 1. Every backticked name appears in a tool result of the task.
 * 2. Every citation resolves to a tool result of the current run.
 * 3. A paragraph that names something the run's evidence shows cites a result
 *    that shows it.
 *
 * Whether the account was fully checked is never judged from the prose: the
 * window states coverage itself, from the ledger.
 */
import { ungrounded } from './grounding'
import type { EvidenceRef, Ledger } from './ledger'

export interface AnswerCheck {
  /** Backticked names no tool result in the task shows. */
  ungrounded: string[]
  /** Cited ids that do not resolve to a finished tool result of this run. */
  unresolved: string[]
  /** Names the run's evidence shows, stated in a paragraph that cites none of it. */
  uncited: string[]
}

const CITATION = /\]\(#ev-([^)\s"'<>]+)\)/g
const NAME = /`([^`\n]{1,256})`/g

export function citationIds(text: string): string[] {
  return [...text.matchAll(CITATION)].map((match) => {
    try {
      return decodeURIComponent(match[1]!)
    } catch {
      return match[1]!
    }
  })
}

export function resolveCitation(
  evidence: Ledger['evidence'],
  id: string | undefined,
): EvidenceRef | undefined {
  if (!id) return undefined
  const ref = evidence.get(id)
  return ref?.view ? ref : undefined
}

/** Prose blocks: blank-line separated, without headings and fenced code. */
function paragraphs(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split('\n')
        .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
        .join('\n')
        .trim(),
    )
    .filter(Boolean)
}

export function checkAnswer(text: string, ledger: Pick<Ledger, 'known' | 'evidence'>): AnswerCheck {
  const unresolved = [
    ...new Set(citationIds(text).filter((id) => !resolveCitation(ledger.evidence, id))),
  ]
  // Names the run's own evidence shows: these can, and must, be cited.
  const shown = new Set<string>()
  for (const ref of ledger.evidence.values()) for (const name of ref.names) shown.add(name)
  const uncited = new Set<string>()
  if (shown.size) {
    for (const block of paragraphs(text)) {
      const named = [...block.matchAll(NAME)]
        .map((match) => match[1]!.trim())
        .filter((name) => shown.has(name))
      if (!named.length) continue
      const cited = citationIds(block)
        .map((id) => resolveCitation(ledger.evidence, id))
        .filter((ref): ref is EvidenceRef => Boolean(ref))
      const covered = named.some((name) => cited.some((ref) => ref.names.has(name)))
      if (!covered) for (const name of named) uncited.add(name)
    }
  }
  return { ungrounded: ungrounded(text, ledger.known), unresolved, uncited: [...uncited] }
}

/** The one correction the harness sends, or undefined when the answer passes. */
export function correctionFor(check: AnswerCheck): string | undefined {
  const parts: string[] = []
  if (check.ungrounded.length)
    parts.push(
      `Your answer names ${check.ungrounded.map((name) => `\`${name}\``).join(', ')}, which no tool result in this task shows.`,
    )
  if (check.unresolved.length)
    parts.push(
      `These citations do not match a tool result of this run: ${check.unresolved
        .slice(0, 6)
        .map((id) => `#ev-${id}`)
        .join(', ')}.`,
    )
  if (check.uncited.length)
    parts.push(
      `A paragraph names ${check.uncited
        .slice(0, 6)
        .map((name) => `\`${name}\``)
        .join(', ')} without citing the tool result that shows it.`,
    )
  if (!parts.length) return undefined
  parts.push(
    'Rewrite the answer so it says only what the tools returned and cites the evidence id of each result it uses, or read it first.',
  )
  return parts.join(' ')
}
