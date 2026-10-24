import type { S3Client } from '@aws-sdk/client-s3'
import type { Context } from '@earendil-works/chord'
import { type Static, type TSchema, Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import type { ToolName, ToolView } from '@shared/contract'
import type { AppDb } from '../db'
import type { Estate } from '../estate/estate'
import type { ProviderConfig, Providers } from '../providers'
import { bound, redact } from '../security/redact'

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
        target = def.target(args as Static<T>)
      } catch {
        target = ''
      }
      const timeout = AbortSignal.timeout(def.timeoutMs)
      const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout
      const progress = (text: string) => api.output(`${text}\n`)
      try {
        await api.details({ target, note: null, view: null }, context)
        const result = await def.run(args as Static<T>, {
          deps,
          context,
          signal,
          conversationId: String(api.conversationId),
          progress,
          setTarget: async (value: string) => {
            await api.details({ target: value, note: null, view: null }, context)
          },
          provider: async (id?: string) => {
            const config = await deps.providers.resolve(id)
            return { config, client: deps.providers.client(config) }
          },
        })
        await deps.db.audit({
          conversationId: String(api.conversationId),
          tool: def.name,
          target: result.view.kind === 'note' ? null : target,
          outcome: 'ok',
        })
        return {
          output: [{ type: 'text' as const, text: envelope(bound(result.model)) }],
          details: {
            target: result.target ?? target,
            note: result.note ?? null,
            view: result.view,
            ms: Date.now() - started,
          } as never,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const refused = error instanceof ScopeError
        await deps.db.audit({
          conversationId: String(api.conversationId),
          tool: def.name,
          target: target || null,
          outcome: refused ? 'refused' : 'error',
        })
        return {
          output: [
            {
              type: 'text' as const,
              text: envelope(`${refused ? 'Refused' : 'Error'}: ${message.slice(0, 400)}`),
            },
          ],
          isError: true,
          details: {
            target,
            note: refused ? 'Outside scope' : message.slice(0, 160),
            view: null,
            ms: Date.now() - started,
          } as never,
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
