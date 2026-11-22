import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import type { Context } from '@earendil-works/chord/context'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { opt, type Schema, type Static, str } from '@earendil-works/pi-schema'
import type { ToolDetails, ToolName, ToolView, UiEntry } from '@shared/contract'
import type { AppDb } from '../db'
import type { ProviderConfig, Providers } from '../providers'
import { describeError } from '../s3/api'
import { bound, redact, redactView, wrapUntrusted } from '../security/redact'
import { assertInScope, ScopeError } from '../security/scope'
import type { Workspace } from '../workspace'

/** A proposal as the conversation shows it. */
export interface ProposedChange {
  changeId: string
  account: string
  title: string
  reason: string
  before: unknown
  after: unknown
}

/** What the app itself does for a tool: wired once the engine and window exist. */
export interface AgentHost {
  /** What the agent is and may do: model, spend, accounts, schedules, version. */
  self(conversationId: string): Promise<Record<string, unknown>>
  rename(taskId: string, title: string): Promise<void>
  pin(taskId: string, pinned: boolean): Promise<void>
  schedules: {
    list(): Promise<unknown[]>
    create(input: {
      name: string
      prompt: string
      cadence: string
      budgetTokens?: number | null
      createdBy: string | null
    }): Promise<unknown>
    cancel(name: string): Promise<unknown>
  }
  changes: {
    /** Check, snapshot and store a proposal; the window asks the user. */
    propose(input: {
      conversationId: string
      providerId?: string
      service: string
      operation: string
      input: Record<string, unknown>
      reason: string
    }): Promise<ProposedChange>
    /** A setting of an account, proposed for the user to approve. */
    proposeSetting(input: {
      conversationId: string
      providerId?: string
      allowChanges?: boolean
      scope?: string[]
      reason: string
    }): Promise<ProposedChange>
  }
  /** Tell the user now. Refused, with the reason, when Settings or the run's limit says no. */
  notify(
    conversationId: string,
    title: string,
    body: string,
  ): Promise<{ shown: boolean; stored?: boolean; reason?: string }>
}

export interface ToolDeps {
  db: AppDb
  providers: Providers
  /** The task's own folder; a result cut for the model is kept here whole. */
  taskDir: (conversationId: string) => string
  datasetsDir: (conversationId: string) => string
  /** Where a dataset the agent keeps across tasks lives. */
  userDatasetsDir: string
  uploadsDir: (conversationId: string) => string
  /** The agent's own folder across tasks: notes, skills, data, scripts, board, exports. */
  workspace?: Workspace
  /** The app's own capabilities; absent in tests and headless mode. */
  host?: AgentHost
  /** Where the bundled skills are written out, for `more` (evidence "skill:<name>"). */
  bundledSkillsDir?: string
  /** How many characters of one result the model gets at once, for this task's model. */
  piece?: (conversationId: string) => number
  /** The projected entries of a conversation, for a delegate's child answer. */
  entries?: (conversationId: string) => Promise<UiEntry[]>
  /** The registered tools themselves, so a child agent can be given fewer. */
  registered?: ToolRegistration[]
  /** The registered tools, as each describes itself; `discover` lists them. */
  catalog?: { name: string; description: string }[]
  lang: () => string
}

export interface ToolRun {
  deps: ToolDeps
  context: Context
  signal: AbortSignal
  conversationId: string
  progress: (text: string) => void
  setTarget: (target: string) => Promise<void>
  provider: (id?: string) => Promise<{ config: ProviderConfig; client: S3Client }>
  /** The client for a bucket's own region; undefined for a single-region endpoint. */
  regional?: (region: string) => S3Client
}

/** The arguments the model supplied, redacted. */
function argsSummary(args: unknown): string | null {
  try {
    const text = JSON.stringify(args)
    if (!text || text === '{}') return null
    const redacted = redact(text)
    return redacted.length > 4_000 ? `${redacted.slice(0, 4_000)}…` : redacted
  } catch {
    return null
  }
}

/** Characters of one result the model gets in one piece; `more` reads the rest. */
export const PIECE = 24_000

/**
 * A piece fits the model: about a fifth of its window (four characters a
 * token), at most `PIECE`. A small local model gets small pieces instead of a
 * prompt its server silently cuts.
 */
export function pieceFor(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return PIECE
  return Math.max(1_000, Math.min(PIECE, Math.floor(contextWindow * 4 * 0.2)))
}

/** The result's path, kept whole when the model got only its first piece. */
export function resultPath(deps: ToolDeps, conversationId: string, evidenceId: string): string {
  return join(deps.taskDir(conversationId), 'results', `${evidenceId.replace(/[^\w.-]/g, '_')}.txt`)
}

/** The text the model gets now: all of it, or its first piece and where the rest is. */
async function fitPiece(
  deps: ToolDeps,
  conversationId: string,
  evidenceId: string | undefined,
  text: string,
): Promise<string> {
  const piece = deps.piece?.(conversationId) ?? PIECE
  if (!evidenceId) return bound(text, piece)
  // Every result is kept, so `more` can read any call again after the
  // conversation was compacted, not only one that was cut.
  const path = resultPath(deps, conversationId, evidenceId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  if (text.length <= piece) return text
  return `${text.slice(0, piece)}\n… ${text.length - piece} more characters. Read them with \`more\` (evidence "${evidenceId}", offset ${piece}).`
}

export function envelope(text: string, evidenceId?: string): string {
  return wrapUntrusted('storage', text, evidenceId)
}

export interface ToolDefinition<T extends Schema> {
  name: ToolName
  description: string
  parameters: T
  target: (args: Static<T>) => string
  run: (
    args: Static<T>,
    run: ToolRun,
  ) => Promise<{
    model: string
    view: ToolView
    note?: string
    target?: string
    /** Images the model sees with the text, when its provider takes them. */
    images?: { data: string; mimeType: string }[]
    /** End the turn after this call: the user decides next (a question, a proposed change). */
    terminate?: boolean
  }>
}

export function agentTool<T extends Schema>(
  deps: ToolDeps,
  def: ToolDefinition<T>,
): ToolRegistration<T> {
  return defineTool({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (args, api, context) => {
      const started = Date.now()
      let target = ''
      try {
        target = redact(def.target(args as Static<T>))
      } catch {
        target = ''
      }
      // Stop is the only end a call has besides its own answer.
      const signal = context.abortSignal ?? new AbortController().signal
      // A delegated child works in the task it was given: the same folder,
      // attachments, datasets and task memory. Its evidence ids carry its own
      // conversation, so they never collide with the parent's.
      const own = String(api.conversationId)
      const conversationId = await deps.db.rootConversation(own)
      const evidenceId = api.callId
        ? own === conversationId
          ? String(api.callId)
          : `${own}.${String(api.callId)}`
        : undefined
      const callArgs = argsSummary(args)
      let regional: ((region: string) => S3Client) | undefined
      let providerName: string | undefined
      let progressNote: string | null = null
      let detailsWrite = Promise.resolve()
      const writeDetails = (value: ToolDetails) => {
        detailsWrite = detailsWrite
          .catch(() => undefined)
          .then(() => api.details(value as never, context))
          .catch(() => undefined)
        return detailsWrite
      }
      const running = (value: string): ToolDetails => ({
        target: value,
        note: null,
        progress: progressNote,
        args: callArgs,
        view: null,
        ms: null,
        status: 'running',
      })
      /** Keep the visible progress line in shaped details, never raw output. */
      const progress = (text: string) => {
        progressNote = redact(text).slice(0, 160)
        void writeDetails(running(target))
        api.output(`${progressNote}\n`)
      }
      try {
        await writeDetails(running(target))
        const result = await def.run(args as Static<T>, {
          deps,
          context,
          signal,
          conversationId,
          progress,
          setTarget: async (value: string) => {
            target = redact(value)
            await writeDetails(running(target))
          },
          provider: async (id?: string) => {
            const config = await deps.providers.resolve(id)
            providerName = config.name
            regional = deps.providers.regional(config)
            return { config, client: deps.providers.client(config) }
          },
          get regional() {
            return regional
          },
        })
        await deps.db.audit({
          conversationId,
          tool: def.name,
          target: result.view.kind === 'note' ? null : target,
          outcome: 'ok',
        })
        // Redacted whole, before it is kept or cut: a secret never straddles two pieces,
        // and the kept result holds no secret either.
        const whole = redact(result.model)
        const sent = await fitPiece(deps, conversationId, evidenceId, whole)
        // When the result was cut for the model, the step says so: the rest waits for `more`.
        const cut = sent !== whole ? 'the agent got the first part; the rest is kept' : null
        const note = [result.note ? redact(result.note) : null, cut].filter(Boolean).join(' · ')
        const details: ToolDetails = {
          target: redact(result.target ?? target),
          note: note || null,
          args: callArgs,
          view: redactView(result.view) as ToolView,
          ms: Date.now() - started,
          status: 'done',
          ...(evidenceId ? { evidenceId } : {}),
          ...(providerName ? { provider: providerName } : {}),
        }
        // Let every queued progress write land before the final shaped result.
        await detailsWrite
        return {
          output: [
            { type: 'text' as const, text: envelope(sent, evidenceId) },
            ...(result.images ?? []).map((image) => ({ type: 'image' as const, ...image })),
          ],
          details: details as never,
          ...(result.terminate ? { control: { terminate: true } } : {}),
        }
      } catch (error) {
        // A provider's error can name the account; it never reaches the model or the window.
        const message = describeError(error)
        const status: ToolDetails['status'] =
          error instanceof ScopeError
            ? 'refused'
            : context.abortSignal?.aborted
              ? 'stopped'
              : 'failed'
        await deps.db.audit({
          conversationId,
          tool: def.name,
          target: target || null,
          outcome: status === 'refused' ? 'refused' : status === 'stopped' ? 'stopped' : 'error',
        })
        const forModel =
          status === 'refused'
            ? `Refused: ${message}`
            : status === 'stopped'
              ? 'Stopped by the user before this call finished.'
              : `Error: ${message}`
        const details: ToolDetails = {
          target,
          note:
            status === 'refused'
              ? redact(message).slice(0, 160)
              : status === 'stopped'
                ? null
                : redact(message).slice(0, 160),
          view: null,
          args: callArgs,
          ms: Date.now() - started,
          status,
          ...(evidenceId ? { evidenceId } : {}),
          ...(providerName ? { provider: providerName } : {}),
        }
        await detailsWrite
        return {
          output: [
            {
              type: 'text' as const,
              text: envelope(
                await fitPiece(deps, conversationId, evidenceId, forModel),
                evidenceId,
              ),
            },
          ],
          isError: true,
          details: details as never,
        }
      }
    },
  })
}

export const providerParam = opt(
  str({ description: 'Storage account id. Optional when only one account is configured.' }),
)

export { assertInScope, ScopeError }
