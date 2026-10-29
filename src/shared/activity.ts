import type { Live, ToolName, ToolStatus, ToolView, UiEntry } from './contract'

/**
 * One ordered account of the current turn's work.
 *
 * The durable entries are the source of truth after a call settles; the live
 * slot only fills the gap before that entry exists. The model never supplies
 * this list, and reasoning is only the provider's summary, never a generated
 * explanation of what happened.
 */

export type ActivityItem =
  | {
      kind: 'reasoning'
      id: string
      at: string
      startedAt: string
      status: ToolStatus
      text: string | null
      live: boolean
    }
  | {
      kind: 'tool'
      id: string
      at: string
      startedAt: string
      status: ToolStatus
      name: ToolName
      target: string
      note: string | null
      args: string | null
      durationMs: number | null
      evidenceId?: string
      callId?: string
      view: ToolView | null
      live: boolean
    }
  | { kind: 'compaction'; id: string; at: string; text: string }
  | { kind: 'resume'; id: string; at: string }

export interface Activity {
  items: ActivityItem[]
  /** Tool calls only; reasoning and plan are not calls. */
  calls: number
  /** Sum of the completed calls' own durations. */
  durationMs: number | null
  running: number
}

function toolOf(entry: Extract<UiEntry, { kind: 'tool' }>): ActivityItem {
  return {
    kind: 'tool',
    id: entry.callId ?? entry.id,
    at: entry.at,
    startedAt: entry.at,
    status: entry.status,
    name: entry.name,
    target: entry.target,
    note: entry.note,
    args: entry.args ?? null,
    durationMs: entry.ms,
    ...(entry.evidenceId ? { evidenceId: entry.evidenceId } : {}),
    ...(entry.callId ? { callId: entry.callId } : {}),
    view: entry.view,
    live: false,
  }
}

export function buildActivity(entries: readonly UiEntry[], live?: Live | null): Activity {
  let boundary = -1
  entries.forEach((entry, index) => {
    if (entry.kind === 'user' || entry.kind === 'resume') boundary = index
  })
  const current = entries.slice(boundary + 1)
  const items: ActivityItem[] = []
  const seenCalls = new Set<string>()

  // A resume is part of the current turn's story even though it is the boundary.
  const boundaryEntry = boundary >= 0 ? entries[boundary] : undefined
  if (boundaryEntry?.kind === 'resume')
    items.push({ kind: 'resume', id: boundaryEntry.id, at: boundaryEntry.at })

  for (const entry of current) {
    if (entry.kind === 'reasoning') {
      items.push({
        kind: 'reasoning',
        id: entry.id,
        at: entry.at,
        startedAt: entry.at,
        status: 'done',
        text: entry.text.trim() || null,
        live: false,
      })
      continue
    }
    if (
      entry.kind === 'tool' &&
      entry.name !== 'plan' &&
      entry.name !== 'skill' &&
      entry.name !== 'ask'
    ) {
      if (entry.callId) seenCalls.add(entry.callId)
      items.push(toolOf(entry))
      continue
    }
    if (entry.kind === 'compaction') {
      items.push({ kind: 'compaction', id: entry.id, at: entry.at, text: entry.text })
    }
  }

  if (live) {
    const lastReasoning = [...items].reverse().find((item) => item.kind === 'reasoning')
    if (live.reasoning && lastReasoning?.text !== live.reasoning.summary) {
      items.push({
        kind: 'reasoning',
        id: `live:reasoning:${live.reasoning.startedAt}`,
        at: live.reasoning.startedAt,
        startedAt: live.reasoning.startedAt,
        status: live.phase === 'reasoning' || live.phase === 'thinking' ? 'running' : 'done',
        text: live.reasoning.summary,
        live: true,
      })
    } else if (
      (live.phase === 'thinking' || live.phase === 'reasoning') &&
      !items.some((item) => item.kind === 'reasoning')
    ) {
      items.push({
        kind: 'reasoning',
        id: `live:thinking:${live.startedAt}`,
        at: live.startedAt,
        startedAt: live.startedAt,
        status: 'running',
        text: null,
        live: true,
      })
    }
    for (const tool of live.tools) {
      if (tool.name === 'plan' || tool.name === 'skill' || tool.name === 'ask') continue
      if (tool.callId && seenCalls.has(tool.callId)) continue
      items.push({
        kind: 'tool',
        id: `live:${tool.callId || tool.name}:${tool.startedAt}`,
        at: tool.startedAt,
        startedAt: tool.startedAt,
        status: tool.status,
        name: tool.name,
        target: tool.target,
        note: tool.note,
        args: tool.args ?? null,
        durationMs: null,
        ...(tool.callId ? { callId: tool.callId } : {}),
        view: null,
        live: true,
      })
    }
  }

  const calls = items.filter((item) => item.kind === 'tool').length
  const durations = items.flatMap((item) =>
    item.kind === 'tool' && item.durationMs !== null ? [item.durationMs] : [],
  )
  return {
    items,
    calls,
    durationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
    running: items.filter((item) => item.kind === 'tool' && item.status === 'running').length,
  }
}
