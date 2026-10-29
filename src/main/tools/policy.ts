import type { S3Client } from '@aws-sdk/client-s3'
import type { Context } from '@earendil-works/chord'
import { type Static, type TSchema, Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import type { ToolDetails, ToolName, ToolView } from '@shared/contract'
import type { AppDb } from '../db'
import { Assessor } from '../estate/assess'
import type { Estate } from '../estate/estate'
import type { ProviderConfig, Providers } from '../providers'
import type { AccessSession } from '../s3/access'
import { bound, escapeTags, redact, redactView } from '../security/redact'

export interface ToolDeps {
  db: AppDb
  providers: Providers
  estate: Estate
  datasetsDir: (conversationId: string) => string
  uploadsDir: (conversationId: string) => string
  lang: () => string
  /** One access session per run, so IAM and SCPs are read once across buckets. */
  accessSessions?: Map<string, AccessSession>
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
  /** The rules' only path to Issues. A tool reads; this applies what the rules decided. */
  assess: Assessor
}

export class ScopeError extends Error {}

/** One bounded, redacted line of the arguments the model supplied. */
function argsSummary(args: unknown): string | null {
  try {
    const text = JSON.stringify(args)
    return text && text !== '{}' ? redact(text).slice(0, 240) : null
  } catch {
    return null
  }
}

export function assertInScope(provider: ProviderConfig, bucket: string): void {
  if (provider.scope.buckets.length === 0) return
  if (!provider.scope.buckets.includes(bucket)) {
    throw new ScopeError(
      `Bucket '${bucket}' is outside this account's scope (${provider.scope.buckets.join(', ')}).`,
    )
  }
}

function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function envelope(text: string, evidenceId?: string): string {
  return `<untrusted-data source="storage"${evidenceId ? ` evidence="${attribute(evidenceId)}"` : ''}>\n${escapeTags(redact(text))}\n</untrusted-data>`
}

export interface ToolDefinition<T extends TSchema> {
  name: ToolName
  description: string
  parameters: T
  timeoutMs: number
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
      const timeout = AbortSignal.timeout(def.timeoutMs)
      const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout
      const conversationId = String(api.conversationId)
      const callArgs = argsSummary(args)
      const assess = new Assessor(deps.db, conversationId)
      let regional: ((region: string) => S3Client) | undefined
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
            regional = deps.providers.regional(config)
            return { config, client: deps.providers.client(config) }
          },
          get regional() {
            return regional
          },
          assess,
        })
        await deps.db.audit({
          conversationId,
          tool: def.name,
          target: result.view.kind === 'note' ? null : target,
          outcome: 'ok',
        })
        const evidenceId = api.callId ? String(api.callId) : undefined
        const sent = bound(result.model)
        // When the result was cut for the model, the step says so: the view may hold more.
        const cut = sent !== result.model ? 'the agent got part of this result' : null
        const note = [result.note ? redact(result.note) : null, cut].filter(Boolean).join(' · ')
        const details: ToolDetails = {
          target: redact(result.target ?? target),
          note: note || null,
          args: callArgs,
          view: redactView(result.view) as ToolView,
          ms: Date.now() - started,
          status: 'done',
          ...(evidenceId ? { evidenceId } : {}),
        }
        // Let every queued progress write land before the final shaped result.
        await detailsWrite
        return {
          output: [{ type: 'text' as const, text: envelope(sent, evidenceId) }],
          details: details as never,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status: ToolDetails['status'] =
          error instanceof ScopeError
            ? 'refused'
            : context.abortSignal?.aborted
              ? 'stopped'
              : timeout.aborted
                ? 'timeout'
                : 'failed'
        await deps.db.audit({
          conversationId,
          tool: def.name,
          target: target || null,
          outcome: status === 'refused' ? 'refused' : status === 'stopped' ? 'stopped' : 'error',
        })
        const forModel =
          status === 'refused'
            ? `Refused: ${message.slice(0, 400)}`
            : status === 'stopped'
              ? 'Stopped by the user before this call finished.'
              : status === 'timeout'
                ? `Timed out after ${Math.round(def.timeoutMs / 1000)} s. Nothing after the last progress line was read.`
                : `Error: ${message.slice(0, 400)}`
        const evidenceId = api.callId ? String(api.callId) : undefined
        const details: ToolDetails = {
          target,
          note:
            status === 'refused'
              ? 'Outside scope'
              : status === 'stopped'
                ? null
                : status === 'timeout'
                  ? 'Timed out'
                  : redact(message).slice(0, 160),
          view: null,
          args: callArgs,
          ms: Date.now() - started,
          status,
          ...(evidenceId ? { evidenceId } : {}),
        }
        await detailsWrite
        return {
          output: [{ type: 'text' as const, text: envelope(forModel, evidenceId) }],
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

export const bucketParam = Type.String({ description: 'Bucket name.' })

export const limitParam = (max: number) =>
  Type.Optional(
    Type.Integer({ minimum: 1, maximum: max, description: `Maximum rows to return (1-${max}).` }),
  )

export { Type }
