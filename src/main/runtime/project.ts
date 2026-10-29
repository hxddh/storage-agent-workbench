/**
 * Projection from pi's durable view to what the window receives.
 *
 * The window never sees raw `entry.model` (the provider-facing messages): only
 * the answer text, a sanitized provider reasoning summary, the request, and each
 * tool call's shaped `details`. Tool status comes from `details.status`, written
 * by `agentTool()`; result text is never parsed for it, because a bucket name or
 * an error body can say anything.
 */
import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable'
import type {
  AttachmentRef,
  ContextRef,
  Live,
  LiveTool,
  NoticeCode,
  ReverifyReport,
  RunTrigger,
  ToolDetails,
  ToolName,
  ToolStatus,
  UiEntry,
  Usage,
} from '@shared/contract'
import { redact } from '../security/redact'
import { TOOL_NAMES as MANIFEST_TOOL_NAMES } from '../tools/registry'

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

const TOOL_NAMES = new Set<ToolName>(MANIFEST_TOOL_NAMES)

function iso(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toISOString() : ''
}

function parts(message: ModelMessage | undefined): Part[] {
  return Array.isArray(message?.content) ? (message.content as Part[]) : []
}

export function textOf(message: ModelMessage | undefined): string {
  if (typeof message?.content === 'string') return message.content.trim()
  return parts(message)
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('')
    .trim()
}

/** The provider's reasoning summary for one assistant message. */
function thinkingOf(message: ModelMessage | undefined): string {
  return parts(message)
    .map((part) => (part.type === 'thinking' ? (part.thinking ?? '') : ''))
    .join('\n')
    .trim()
}

function toolName(value: string | undefined): ToolName | null {
  return value && TOOL_NAMES.has(value as ToolName) ? (value as ToolName) : null
}

/** `agentTool()` details; 17.x results carry the same shape without `status`. */
function isDetails(value: unknown): value is Partial<ToolDetails> & { target: string } {
  return Boolean(value) && typeof value === 'object' && 'target' in (value as object)
}

/** What a run-starting entry carries. */
export interface RunData {
  trigger: RunTrigger
  text?: string
  attachments?: AttachmentRef[]
  context?: ContextRef[]
}

/** A scripted call: the same shaped details `agentTool()` returns to a model run. */
export interface CallData {
  name: ToolName
  at: string
  details: ToolDetails
}

function toolEntry(
  id: string,
  at: string,
  name: ToolName,
  details: (Partial<ToolDetails> & { target: string }) | null,
  fallback: { isError: boolean; text: string; ms?: number; callId?: string },
): UiEntry {
  const status: ToolStatus = details?.status ?? (fallback.isError ? 'failed' : 'done')
  return {
    id,
    kind: 'tool',
    at,
    name,
    target: details?.target ?? '',
    status: status === 'running' ? 'failed' : status,
    note: details ? (details.note ?? null) : fallback.isError ? blockedNote(fallback.text) : null,
    args: details?.args ?? null,
    ms: details?.ms ?? fallback.ms ?? null,
    view: details?.view ?? null,
    ...(fallback.callId ? { callId: fallback.callId } : {}),
    ...(details?.evidenceId ? { evidenceId: details.evidenceId } : {}),
    ...(details?.key ? { key: details.key } : {}),
    ...(details?.assessed ? { assessed: details.assessed } : {}),
  }
}

export function mapEntries(entries: readonly EntryRecord[]): UiEntry[] {
  const out: UiEntry[] = []
  const toolNames = new Map<string, string>()
  for (const entry of entries) {
    const id = String(entry.id)
    const message = entry.model?.[0] as ModelMessage | undefined
    const at = iso(message?.timestamp)
    switch (entry.kind) {
      case 'sa.run': {
        const data = (entry.data ?? {}) as Partial<RunData> & { at?: string }
        if (data.trigger === 'check' || data.trigger === 'recheck') {
          out.push({ id, kind: 'check', at: data.at ?? at, mode: data.trigger })
          break
        }
        out.push({
          id,
          kind: 'user',
          at,
          text: data.text ?? '',
          attachments: data.attachments ?? [],
          ...(data.context?.length ? { context: data.context } : {}),
        })
        break
      }
      case 'sa.steer': {
        const data = (entry.data ?? {}) as Partial<RunData>
        out.push({
          id,
          kind: 'steer',
          at,
          text: data.text ?? '',
          attachments: data.attachments ?? [],
          ...(data.context?.length ? { context: data.context } : {}),
        })
        break
      }
      case 'sa.resume':
        out.push({ id, kind: 'resume', at })
        break
      case 'sa.call': {
        const data = entry.data as CallData | undefined
        const name = toolName(data?.name)
        if (data && name)
          out.push(
            toolEntry(id, data.at, name, data.details, {
              isError: data.details.status !== 'done',
              text: '',
            }),
          )
        break
      }
      case 'sa.answer': {
        const data = entry.data as { text?: string; at?: string } | undefined
        if (data?.text)
          out.push({ id, kind: 'answer', at: data.at ?? at, text: data.text, source: 'check' })
        break
      }
      case 'sa.reverify': {
        const data = entry.data as ReverifyReport | undefined
        if (data) out.push({ id, kind: 'reverify', at: data.at, report: data })
        break
      }
      case 'sa.notice': {
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
        break
      }
      // `pi.user` entries are the harness's own messages to the model: a
      // correction is part of the run, and the window shows it.
      case 'pi.user': {
        const text = textOf(message)
        if (text)
          out.push({ id, kind: 'validation', at, text: redact(text).slice(0, 1200), tone: 'warn' })
        break
      }
      case 'pi.assistant': {
        if (!message) break
        for (const part of parts(message))
          if (part.type === 'toolCall' && part.id && part.name) toolNames.set(part.id, part.name)
        if (parts(message).some((part) => part.type === 'thinking'))
          out.push({
            id: `${id}:thinking`,
            kind: 'reasoning',
            at,
            text: redact(thinkingOf(message)).slice(0, 4000),
          })
        const text = textOf(message)
        if (text) out.push({ id, kind: 'answer', at, text, source: 'model' })
        else if (message.stopReason === 'error' && message.errorMessage)
          out.push({
            id,
            kind: 'notice',
            at,
            text: message.errorMessage.slice(0, 300),
            tone: 'error',
            action: 'retry',
          })
        break
      }
      case 'pi.tool-result': {
        if (!message) break
        const name = toolName(message.toolName ?? toolNames.get(message.toolCallId ?? ''))
        if (!name) break
        const details = isDetails(message.details) ? message.details : null
        // A call the harness blocked never read anything; it is not a check.
        if (!details && message.isError && BLOCKED.test(textOf(message))) break
        // A result without our details came from pi itself: the call never
        // reached `agentTool()` (aborted before start, or faulted).
        out.push(
          toolEntry(id, at, name, details, {
            isError: Boolean(message.isError),
            text: textOf(message),
            ...(message.durationMs !== undefined ? { ms: message.durationMs } : {}),
            ...(message.toolCallId ? { callId: message.toolCallId } : {}),
          }),
        )
        break
      }
      case 'pi.compaction':
        out.push({ id, kind: 'compaction', at: '', text: 'Earlier steps were compacted.' })
        break
      default:
        break
    }
  }
  return out
}

/** Model rounds of the current run: assistant messages that called a tool, blocked ones too. */
export function roundsOf(entries: readonly EntryRecord[]): number {
  let rounds = 0
  for (const entry of entries) {
    if (entry.kind === 'sa.run' || entry.kind === 'sa.resume') rounds = 0
    if (entry.kind !== 'pi.assistant') continue
    const message = entry.model?.[0] as ModelMessage | undefined
    if (parts(message).some((part) => part.type === 'toolCall')) rounds += 1
  }
  return rounds
}

const BLOCKED = /step budget reached|already ran in this (?:task|run)/i

/** A result pi wrote without running the tool; its text is not shown. */
function blockedNote(text: string): string | null {
  return text ? 'Did not run' : null
}

interface LiveDoc {
  run?: unknown
  generation?: { message?: ModelMessage; retry?: { at: number; error: string } }
  tools?: { callId: string; name: string; status: string; output?: string; details?: unknown }[]
}

/** The latest live state; durable entries take over as each call settles. */
export class LiveTracker {
  private readonly runStarted = new Map<string, string>()
  private readonly toolStarted = new Map<string, string>()
  private readonly reasoningStarted = new Map<string, string>()

  map(view: ConversationView, taskId: string): Live | null {
    const live = view.docs['pi.live'] as LiveDoc | undefined
    if (!live?.run) {
      this.runStarted.delete(taskId)
      this.reasoningStarted.delete(taskId)
      this.toolStarted.clear()
      return null
    }
    const startedAt = this.runStarted.get(taskId) ?? new Date().toISOString()
    this.runStarted.set(taskId, startedAt)
    const tools: LiveTool[] = []
    for (const slot of live.tools ?? []) {
      const name = toolName(slot.name)
      if (!name) continue
      const details = isDetails(slot.details) ? slot.details : null
      const since = this.toolStarted.get(slot.callId) ?? new Date().toISOString()
      this.toolStarted.set(slot.callId, since)
      const status: ToolStatus =
        details?.status ??
        (slot.status === 'done' ? 'done' : slot.status === 'error' ? 'failed' : 'running')
      tools.push({
        callId: slot.callId,
        name,
        target: details?.target ?? '',
        note: details?.progress ?? details?.note ?? null,
        args: details?.args ?? null,
        status,
        startedAt: since,
      })
    }
    const message = live.generation?.message
    const summary = thinkingOf(message)
    const hasThinking = parts(message).some((part) => part.type === 'thinking')
    if ((hasThinking || summary) && !this.reasoningStarted.has(taskId))
      this.reasoningStarted.set(taskId, new Date().toISOString())
    const reasoningStarted = this.reasoningStarted.get(taskId)
    const reasoning = reasoningStarted
      ? {
          summary: summary ? redact(summary).slice(0, 4000) : null,
          startedAt: reasoningStarted,
        }
      : null
    const text = textOf(message)
    const running = tools.some((tool) => tool.status === 'running')
    return {
      phase: running ? 'tool' : text ? 'writing' : reasoning ? 'reasoning' : 'thinking',
      tools,
      reasoning,
      text: text || null,
      startedAt,
    }
  }
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
