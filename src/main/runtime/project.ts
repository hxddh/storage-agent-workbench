/**
 * Projection from pi's durable view to what the window receives.
 *
 * The window never sees `entry.model` (the provider-facing messages): only the
 * answer text, the request, and each tool call's shaped `details`. Tool status
 * comes from `details.status`, written by `agentTool()`; result text is never
 * parsed for it, because a bucket name or an error body can say anything.
 */
import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable'
import type {
  AttachmentRef,
  AuditReport,
  ContextRef,
  Live,
  LiveTool,
  NoticeCode,
  ToolDetails,
  ToolName,
  ToolStatus,
  UiEntry,
  Usage,
} from '@shared/contract'

interface Part {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
}

interface ModelMessage {
  role?: string
  content?: unknown
  timestamp?: number
  stopReason?: string
  errorMessage?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
  durationMs?: number
  details?: unknown
}

const TOOL_NAMES = new Set<ToolName>([
  'survey',
  'buckets',
  'objects',
  'object',
  'config',
  'probe',
  'estate',
  'fix',
  'note',
  'query',
])

function iso(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toISOString() : ''
}

function parts(message: ModelMessage | undefined): Part[] {
  return Array.isArray(message?.content) ? (message.content as Part[]) : []
}

export function textOf(message: ModelMessage | undefined): string {
  return parts(message)
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('')
    .trim()
}

function toolName(value: string | undefined): ToolName | null {
  return value && TOOL_NAMES.has(value as ToolName) ? (value as ToolName) : null
}

/** `agentTool()` details; 17.x results carry the same shape without `status`. */
function isDetails(value: unknown): value is Partial<ToolDetails> & { target: string } {
  return Boolean(value) && typeof value === 'object' && 'target' in (value as object)
}

export function mapEntries(entries: readonly EntryRecord[]): UiEntry[] {
  const out: UiEntry[] = []
  const toolNames = new Map<string, string>()
  for (const entry of entries) {
    const id = String(entry.id)
    const message = entry.model?.[0] as ModelMessage | undefined
    if (entry.kind === 'sa.user') {
      const data = entry.data as
        | { text?: string; attachments?: AttachmentRef[]; context?: ContextRef[] }
        | undefined
      out.push({
        id,
        kind: 'user',
        at: iso(message?.timestamp),
        text: data?.text ?? '',
        attachments: data?.attachments ?? [],
        ...(data?.context?.length ? { context: data.context } : {}),
      })
      continue
    }
    if (entry.kind === 'sa.audit') {
      const report = entry.data as AuditReport | undefined
      if (report) {
        for (const [index, check] of report.checks.entries())
          out.push({
            id: `${id}:${index}`,
            kind: 'tool',
            at: check.at,
            name: check.name,
            target: check.target,
            status: check.status,
            note: check.note,
            ms: check.ms,
            view: check.view,
          })
        out.push({ id: `${id}:answer`, kind: 'answer', at: report.at, text: report.verdict })
      }
      continue
    }
    // `pi.user` entries are the harness's own messages to the model (a grounding
    // correction); they are not the user's questions.
    if (entry.kind === 'sa.continue') {
      out.push({ id, kind: 'resume', at: iso(message?.timestamp) })
      continue
    }
    if (entry.kind === 'pi.assistant') {
      if (!message) continue
      for (const part of parts(message)) {
        if (part.type === 'toolCall' && part.id && part.name) toolNames.set(part.id, part.name)
      }
      const text = textOf(message)
      if (text) {
        out.push({ id, kind: 'answer', at: iso(message.timestamp), text })
      } else if (message.stopReason === 'error' && message.errorMessage) {
        out.push({
          id,
          kind: 'notice',
          at: iso(message.timestamp),
          text: message.errorMessage.slice(0, 300),
          tone: 'error',
          action: 'retry',
        })
      }
      continue
    }
    if (entry.kind === 'pi.tool-result') {
      if (!message) continue
      const name = toolName(message.toolName ?? toolNames.get(message.toolCallId ?? ''))
      if (!name) continue
      const details = isDetails(message.details) ? message.details : null
      // A call the harness blocked never read anything; it is not a check.
      if (!details && message.isError && BLOCKED.test(textOf(message))) continue
      // A result without our details came from pi itself: the call never reached
      // `agentTool()` (blocked by a hook, aborted before start, or faulted).
      const status: ToolStatus = details?.status ?? (message.isError ? 'failed' : 'done')
      out.push({
        id,
        kind: 'tool',
        at: iso(message.timestamp),
        name,
        target: details?.target ?? '',
        status: status === 'running' ? 'failed' : status,
        note: details
          ? (details.note ?? null)
          : message.isError
            ? blockedNote(textOf(message))
            : null,
        ms: details?.ms ?? message.durationMs ?? null,
        view: details?.view ?? null,
        callId: message.toolCallId,
      })
      continue
    }
    if (entry.kind === 'pi.compaction') {
      out.push({ id, kind: 'compaction', at: '', text: 'Earlier steps were compacted.' })
      continue
    }
    if (entry.kind === 'sa.reverify') {
      const data = entry.data as import('@shared/contract').ReverifyReport | undefined
      if (data)
        out.push({ id, kind: 'reverify', at: iso(message?.timestamp) || data.at, report: data })
      continue
    }
    if (entry.kind === 'sa.notice') {
      const data = entry.data as
        | {
            code?: NoticeCode
            text?: string
            tone?: 'info' | 'warn' | 'error'
            action?: 'retry' | 'continue'
          }
        | undefined
      out.push({
        id,
        kind: 'notice',
        at: '',
        ...(data?.code ? { code: data.code } : {}),
        text: data?.text ?? '',
        tone: data?.tone ?? 'info',
        ...(data?.action ? { action: data.action } : {}),
      })
    }
  }
  return out
}

const BLOCKED = /step budget reached|already ran in this task/i

/** A result pi wrote without running the tool; its text is not shown. */
function blockedNote(text: string): string | null {
  return text ? 'Did not run' : null
}

interface LiveDoc {
  run?: unknown
  generation?: { message?: ModelMessage; retry?: { at: number; error: string } }
  tools?: { callId: string; name: string; status: string; output?: string; details?: unknown }[]
}

export class LiveTracker {
  private readonly runStarted = new Map<string, string>()
  private readonly toolStarted = new Map<string, string>()

  map(view: ConversationView, taskId: string): Live | null {
    const live = view.docs['pi.live'] as LiveDoc | undefined
    if (!live?.run) {
      this.runStarted.delete(taskId)
      return null
    }
    const startedAt = this.runStarted.get(taskId) ?? new Date().toISOString()
    this.runStarted.set(taskId, startedAt)
    const tools: LiveTool[] = []
    for (const slot of live.tools ?? []) {
      if (slot.status === 'done') {
        this.toolStarted.delete(slot.callId)
        continue
      }
      const name = toolName(slot.name)
      if (!name) continue
      const since = this.toolStarted.get(slot.callId) ?? new Date().toISOString()
      this.toolStarted.set(slot.callId, since)
      const details = isDetails(slot.details) ? slot.details : null
      tools.push({
        callId: slot.callId,
        name,
        target: details?.target ?? '',
        note: lastLine(slot.output),
        startedAt: since,
      })
    }
    const message = live.generation?.message
    const text = textOf(message)
    const reasoning = parts(message).some((part) => part.type === 'thinking')
    return {
      phase: tools.length ? 'tool' : text ? 'writing' : reasoning ? 'reasoning' : 'thinking',
      tools,
      text: text || null,
      startedAt,
    }
  }
}

function lastLine(output: string | undefined): string | null {
  if (!output) return null
  const last = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  return last ? last.slice(0, 90) : null
}

interface UsageRecord {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  cost?: { total?: number }
}

/** The task's model spend from pi's `pi.usage` ledger. */
export function usageOf(view: ConversationView): Usage | null {
  const doc = view.docs['pi.usage'] as
    | { models?: Record<string, UsageRecord>; tools?: Record<string, UsageRecord> }
    | undefined
  const records = Object.values(doc?.models ?? {})
  if (!records.length) return null
  const sum: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 }
  for (const record of records) {
    sum.input += record.input ?? 0
    sum.output += record.output ?? 0
    sum.cacheRead += record.cacheRead ?? 0
    sum.cacheWrite += record.cacheWrite ?? 0
    sum.reasoning += record.reasoning ?? 0
    sum.cost += record.cost?.total ?? 0
  }
  return sum
}

export function deriveTitle(text: string): string {
  const first = text.trim().split('\n')[0] ?? ''
  const clean = first
    .replace(/[#*`_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'New task'
  return clean.length > 64 ? `${clean.slice(0, 61)}…` : clean
}
