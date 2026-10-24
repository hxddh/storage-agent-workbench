import type { S3Client } from '@aws-sdk/client-s3'
import type { Context } from '@earendil-works/chord'
import { type Static, type TSchema, Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import type { ToolDetails, ToolName, ToolView } from '@shared/contract'
import type { AppDb } from '../db'
import type { Estate } from '../estate/estate'
import type { ProviderConfig, Providers } from '../providers'
import { bound, redact, redactView } from '../security/redact'

export interface ToolDeps {
  db: AppDb
  providers: Providers
  estate: Estate
  datasetsDir: (conversationId: string) => string
  uploadsDir: (conversationId: string) => string
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

export class ScopeError extends Error {}

export function assertInScope(provider: ProviderConfig, bucket: string): void {
  if (provider.scope.buckets.length === 0) return
  if (!provider.scope.buckets.includes(bucket)) {
    throw new ScopeError(
      `Bucket '${bucket}' is outside this account's scope (${provider.scope.buckets.join(', ')}).`,
    )
  }
}

export function envelope(text: string): string {
  return `<untrusted-data source="storage">\n${redact(text)}\n</untrusted-data>`
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
      const progress = (text: string) => api.output(`${redact(text)}\n`)
      const conversationId = String(api.conversationId)
      let regional: ((region: string) => S3Client) | undefined
      const running = (value: string): ToolDetails => ({
        target: value,
        note: null,
        view: null,
        ms: null,
        status: 'running',
      })
      try {
        await api.details(running(target) as never, context)
        const result = await def.run(args as Static<T>, {
          deps,
          context,
          signal,
          conversationId,
          progress,
          setTarget: async (value: string) => {
            target = redact(value)
            await api.details(running(target) as never, context)
          },
          provider: async (id?: string) => {
            const config = await deps.providers.resolve(id)
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
        const details: ToolDetails = {
          target: redact(result.target ?? target),
          note: result.note ? redact(result.note) : null,
          view: redactView(result.view) as ToolView,
          ms: Date.now() - started,
          status: 'done',
        }
        return {
          output: [{ type: 'text' as const, text: envelope(bound(result.model)) }],
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
          ms: Date.now() - started,
          status,
        }
        return {
          output: [{ type: 'text' as const, text: envelope(forModel) }],
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
