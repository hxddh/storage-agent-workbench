/**
 * Reading records: the counts of each account survey a turn made, kept as the
 * agent's memory (`estate` history, a change plan's baseline). They hold
 * counts, never a verdict, request text, prose, policy or an account id, and
 * the window never shows them.
 */
import type { ToolView, UiEntry } from '@shared/contract'

export interface SurveyCounts {
  providerId: string
  at: string
  visible: number
  processed: number
  pending: number
  denied: number
  unknown: number
  /** Buckets the survey listed but did not reach because the listing was cut. */
  truncated: number
}

type Survey = Extract<ToolView, { kind: 'survey' }>

/** The index of the user message that starts the current turn; a steer joins it. */
export function turnStart(entries: readonly UiEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1)
    if (entries[index]!.kind === 'user') return index
  return -1
}

interface Open {
  counts: SurveyCounts
  denied: Set<string>
  unknown: Set<string>
}

/**
 * The latest account-wide survey of each account in the current turn. A
 * survey narrowed to named buckets adds what it read to the account's survey
 * in the same turn; on its own it speaks only for its buckets and is no record.
 */
export function turnSurveys(entries: readonly UiEntry[]): SurveyCounts[] {
  const byAccount = new Map<string, Open>()
  for (const entry of entries.slice(Math.max(0, turnStart(entries)))) {
    if (entry.kind !== 'tool' || entry.status !== 'done' || entry.view?.kind !== 'survey') continue
    const view: Survey = entry.view
    const providerId = view.providerId
    if (!providerId) continue
    if (!view.scoped) {
      const pending = view.coverage.pending ?? 0
      byAccount.set(providerId, {
        counts: {
          providerId,
          at: entry.at,
          visible: view.coverage.visible,
          processed: view.coverage.processed,
          pending,
          denied: 0,
          unknown: 0,
          truncated: view.coverage.truncated
            ? Math.max(0, view.coverage.visible - view.coverage.processed - pending)
            : 0,
        },
        denied: new Set(view.coverage.denied),
        unknown: new Set(view.coverage.unknown),
      })
      continue
    }
    const open = byAccount.get(providerId)
    if (!open) continue
    open.counts.processed = Math.min(
      open.counts.visible,
      open.counts.processed + view.coverage.processed,
    )
    for (const row of view.buckets.rows) {
      open.denied.delete(String(row[0]))
      open.unknown.delete(String(row[0]))
    }
    for (const bucket of view.coverage.denied) open.denied.add(bucket)
    for (const bucket of view.coverage.unknown) open.unknown.add(bucket)
    if (entry.at > open.counts.at) open.counts.at = entry.at
  }
  return [...byAccount.values()].map((open) => ({
    ...open.counts,
    denied: open.denied.size,
    unknown: open.unknown.size,
  }))
}
