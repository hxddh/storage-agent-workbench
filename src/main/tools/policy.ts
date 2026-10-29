import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import type { Context } from '@earendil-works/chord'
import { type Static, type TSchema, Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import type { ToolDetails, ToolName, ToolView, UiEntry } from '@shared/contract'
import type { AppDb } from '../db'
import type { MemoryStore } from '../memory'
import type { ProviderConfig, Providers } from '../providers'
import { describeError } from '../s3/api'
import { bound, escapeTags, redact, redactView } from '../security/redact'
import { assertInScope, ScopeError } from '../security/scope'

export interface ToolDeps {
  db: AppDb
  providers: Providers
  /** The task's own folder; a result cut for the model is kept here whole. */
  taskDir: (conversationId: string) => string
  datasetsDir: (conversationId: string) => string
  uploadsDir: (conversationId: string) => string
  memory?: MemoryStore
  /** The projected entries of a conversation, for a delegate's child answer. */
  entries?: (conversationId: string) => Promise<UiEntry[]>
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

function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Characters of one result the model gets in one piece; `more` reads the rest. */
export const PIECE = 24_000

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
  if (text.length <= PIECE) return text
  if (!evidenceId) return bound(text, PIECE)
  const path = resultPath(deps, conversationId, evidenceId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return `${text.slice(0, PIECE)}\n… ${text.length - PIECE} more characters. Read them with \`more\` (evidence "${evidenceId}", offset ${PIECE}).`
}

export function envelope(text: string, evidenceId?: string): string {
  return `<untrusted-data source="storage"${evidenceId ? ` evidence="${attribute(evidenceId)}"` : ''}>\n${escapeTags(redact(text))}\n</untrusted-data>`
}

export interface ToolDefinition<T extends TSchema> {
  name: ToolName
  description: string
  parameters: T
  target: (args: Static<T>) => string
  run: (
    args: Static<T>,
    run: ToolRun,
  ) => Promise<{ model: string; view: ToolView; note?: string; target?: string }>
}

export function agentTool<T extends TSchema>(
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
      const conversationId = String(api.conversationId)
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
        const evidenceId = api.callId ? String(api.callId) : undefined
        const sent = await fitPiece(deps, conversationId, evidenceId, result.model)
        // When the result was cut for the model, the step says so: the rest waits for `more`.
        const cut = sent !== result.model ? 'the agent got the first part; the rest is kept' : null
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
          output: [{ type: 'text' as const, text: envelope(sent, evidenceId) }],
          details: details as never,
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
        const evidenceId = api.callId ? String(api.callId) : undefined
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

export const providerParam = Type.Optional(
  Type.String({ description: 'Storage account id. Optional when only one account is configured.' }),
)

export { assertInScope, ScopeError, Type }
