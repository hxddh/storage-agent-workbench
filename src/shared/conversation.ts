/**
 * The conversation as the window renders it.
 *
 * One ordered thread: the user's messages, and between them everything the
 * agent did, in the order it happened — its text, provider reasoning
 * summaries, tool calls with their shaped results, a clarifying question, a
 * request to accept a risk, notices. The live slot is appended at the end.
 * Nothing is regrouped into a report, folded into a summary, or added by the
 * app: what the agent did and said is what the page shows.
 */
import type {
  AttachmentRef,
  ContextRef,
  Live,
  NoticeCode,
  ToolName,
  ToolStatus,
  ToolView,
  UiEntry,
} from './contract'

export type ThreadItem =
  | {
      kind: 'user'
      id: string
      at: string
      text: string
      attachments: AttachmentRef[]
      context?: ContextRef[]
      /** Sent while the agent was working; it joined that turn. */
      steer: boolean
    }
  | { kind: 'text'; id: string; at: string; text: string; streaming: boolean }
  | { kind: 'thought'; id: string; at: string; text: string | null; running: boolean }
  | {
      kind: 'tool'
      id: string
      /** The durable entry id; null while the call is live. */
      entryId: string | null
      at: string
      name: ToolName
      target: string
      status: ToolStatus
      note: string | null
      args: string | null
      ms: number | null
      evidenceId: string | null
      view: ToolView | null
    }
  | {
      kind: 'notice'
      id: string
      code?: NoticeCode
      text: string
      tone: 'info' | 'warn' | 'error'
      action?: 'retry' | 'continue'
    }
  | { kind: 'resume'; id: string; at: string }
  | { kind: 'compaction'; id: string; at: string }

export function thread(entries: readonly UiEntry[], live: Live | null = null): ThreadItem[] {
  const items: ThreadItem[] = []
  const settledCalls = new Set<string>()
  for (const entry of entries) {
    switch (entry.kind) {
      case 'user':
      case 'steer':
        items.push({
          kind: 'user',
          id: entry.id,
          at: entry.at,
          text: entry.text,
          attachments: entry.attachments,
          ...(entry.context?.length ? { context: entry.context } : {}),
          steer: entry.kind === 'steer',
        })
        break
      case 'answer':
        if (entry.text.trim())
          items.push({
            kind: 'text',
            id: entry.id,
            at: entry.at,
            text: entry.text,
            streaming: false,
          })
        break
      case 'reasoning':
        items.push({
          kind: 'thought',
          id: entry.id,
          at: entry.at,
          text: entry.text.trim() || null,
          running: false,
        })
        break
      case 'tool':
        for (const id of [entry.callId, entry.evidenceId]) if (id) settledCalls.add(id)
        items.push({
          kind: 'tool',
          id: entry.id,
          entryId: entry.id,
          at: entry.at,
          name: entry.name,
          target: entry.target,
          status: entry.status,
          note: entry.note,
          args: entry.args ?? null,
          ms: entry.ms,
          evidenceId: entry.evidenceId ?? entry.callId ?? null,
          view: entry.view,
        })
        break
      case 'notice':
        items.push({
          kind: 'notice',
          id: entry.id,
          ...(entry.code ? { code: entry.code } : {}),
          text: entry.text,
          tone: entry.tone,
          ...(entry.action ? { action: entry.action } : {}),
        })
        break
      case 'resume':
        items.push({ kind: 'resume', id: entry.id, at: entry.at })
        break
      case 'compaction':
        items.push({ kind: 'compaction', id: entry.id, at: entry.at })
        break
    }
  }
  if (!live) return items
  const lastThought = items.findLast((item) => item.kind === 'thought')
  if (live.reasoning && lastThought?.text !== live.reasoning.summary)
    items.push({
      kind: 'thought',
      id: `live:thought:${live.reasoning.startedAt}`,
      at: live.reasoning.startedAt,
      text: live.reasoning.summary,
      running: live.phase === 'reasoning' || live.phase === 'thinking',
    })
  for (const tool of live.tools) {
    if (tool.callId && settledCalls.has(tool.callId)) continue
    items.push({
      kind: 'tool',
      id: `live:${tool.callId}`,
      entryId: null,
      at: tool.startedAt,
      name: tool.name,
      target: tool.target,
      status: tool.status,
      note: tool.note,
      args: tool.args ?? null,
      ms: null,
      evidenceId: tool.callId || null,
      view: null,
    })
  }
  if (live.text?.trim())
    items.push({
      kind: 'text',
      id: `live:text:${live.startedAt}`,
      at: live.startedAt,
      text: live.text,
      streaming: true,
    })
  return items
}

/**
 * The plan is one checklist the agent keeps updating, so within a turn only
 * its newest version is shown; the earlier ones are the same list, older.
 */
export function latestPlans(items: readonly ThreadItem[]): ThreadItem[] {
  const superseded = new Set<string>()
  let last: string | null = null
  for (const item of items) {
    if (item.kind === 'user' && !item.steer) last = null
    else if (item.kind === 'tool' && item.name === 'plan' && item.view?.kind === 'plan') {
      if (last) superseded.add(last)
      last = item.id
    }
  }
  return superseded.size ? items.filter((item) => !superseded.has(item.id)) : [...items]
}

/** The tool call a `[n](#ev-<id>)` link in the agent's text points at. */
export function callFor(items: readonly ThreadItem[], evidenceId: string): ThreadItem | undefined {
  return items.find(
    (item) =>
      item.kind === 'tool' && (item.evidenceId === evidenceId || item.entryId === evidenceId),
  )
}

/** The question the agent is waiting on, when its latest act was `ask`. */
export function pendingQuestion(items: readonly ThreadItem[]): string | null {
  const last = items.findLast((item) => item.kind !== 'notice')
  return last?.kind === 'tool' && last.name === 'ask' && last.view?.kind === 'question'
    ? last.id
    : null
}

/** The agent's last text in the conversation, for Copy. */
export function lastText(items: readonly ThreadItem[]): string {
  return items.findLast((item) => item.kind === 'text')?.text ?? ''
}

/** The conversation as Markdown: messages and the calls between them. */
export function transcriptMarkdown(items: readonly ThreadItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (item.kind === 'user') parts.push(`**You:** ${item.text}`)
    else if (item.kind === 'text') parts.push(item.text)
    else if (item.kind === 'tool')
      parts.push(
        `> ${item.name}${item.target ? ` · ${item.target}` : ''} · ${item.status}${item.note ? ` · ${item.note}` : ''}`,
      )
    else if (item.kind === 'notice' && item.text) parts.push(`> ${item.text}`)
  }
  return parts.join('\n\n')
}

/** Rows the search index stores for a task: every user message and every agent text. */
export function searchRows(
  entries: readonly UiEntry[],
): { entryId: string; kind: string; text: string; at: string }[] {
  return entries.flatMap((entry) =>
    (entry.kind === 'user' || entry.kind === 'steer') && entry.text.trim()
      ? [{ entryId: entry.id, kind: 'user', text: entry.text, at: entry.at }]
      : entry.kind === 'answer' && entry.text.trim()
        ? [{ entryId: entry.id, kind: 'answer', text: entry.text, at: entry.at }]
        : [],
  )
}
