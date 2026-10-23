import { randomUUID } from 'node:crypto'
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3'
import type { Account, AccountInput } from '@shared/contract'
import type { AppDb, ProviderRow } from './db'
import { maskKey } from './security/redact'
import type { Vault } from './security/vault'

export interface ProviderConfig {
  id: string
  name: string
  endpoint: string
  region: string
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string | null
  scope: { buckets: string[] }
}

function parseScope(json: string): { buckets: string[] } {
  try {
    const value = JSON.parse(json) as { buckets?: unknown }
    return {
      buckets: Array.isArray(value.buckets)
        ? value.buckets.filter((b) => typeof b === 'string')
        : [],
    }
  } catch {
    return { buckets: [] }
  }
}

export class Providers {
  constructor(
    private readonly db: AppDb,
    private readonly vault: Vault,
  ) {}

  async list(): Promise<Account[]> {
    const rows = await this.db.listProviders()
    const out: Account[] = []
    for (const row of rows) {
      const watch = await this.db.watchFor(row.id)
      out.push({
        id: row.id,
        name: row.name,
        endpoint: row.endpoint,
        region: row.region,
        forcePathStyle: row.force_path_style === 1,
        accessKeyMasked: maskKey(row.access_key_id),
        hasSessionToken: Boolean(row.session_ref),
        scope: parseScope(row.scope_json),
        watch: {
          enabled: watch.enabled,
          intervalHours: watch.intervalHours,
          lastRunAt: watch.lastRunAt,
        },
      })
    }
    return out
  }

  async config(id: string): Promise<ProviderConfig> {
    const row = await this.db.getProvider(id)
    if (!row) throw new Error(`Unknown storage account: ${id}`)
    return this.fromRow(row)
  }

  async resolve(id?: string): Promise<ProviderConfig> {
    const rows = await this.db.listProviders()
    if (id) {
      const row = rows.find((r) => r.id === id || r.name === id)
      if (!row) throw new Error(`Unknown storage account: ${id}`)
      return this.fromRow(row)
    }
    if (rows.length === 0) throw new Error('No storage account is configured yet.')
    if (rows.length === 1) return this.fromRow(rows[0]!)
    throw new Error(
      `Several storage accounts are configured (${rows
        .map((r) => r.name)
        .join(', ')}). Pass provider_id.`,
    )
  }

  async save(input: AccountInput): Promise<Account> {
    const existing = input.id ? await this.db.getProvider(input.id) : undefined
    const id = existing?.id ?? randomUUID()
    const secret = input.secretAccessKey?.trim()
    const secretRef = secret ? this.vault.seal(secret) : existing?.secret_ref
    if (!secretRef) throw new Error('A secret access key is required.')
    const sessionRef = input.sessionToken?.trim()
      ? this.vault.seal(input.sessionToken.trim())
      : (existing?.session_ref ?? null)
    await this.db.upsertProvider({
      id,
      name: input.name.trim() || 'Storage',
      endpoint: input.endpoint.trim(),
      region: input.region.trim() || 'us-east-1',
      force_path_style: input.forcePathStyle ? 1 : 0,
      access_key_id: input.accessKeyId.trim() || existing?.access_key_id || null,
      secret_ref: secretRef,
      session_ref: sessionRef,
      scope_json: JSON.stringify({ buckets: input.scope.buckets.filter(Boolean) }),
      created_at: existing?.created_at ?? new Date().toISOString(),
    })
    const account = (await this.list()).find((a) => a.id === id)
    if (!account) throw new Error('The account could not be saved.')
    return account
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteProvider(id)
  }

  async test(id: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const provider = await this.config(id)
      const client = this.client(provider)
      const response = await client.send(new ListBucketsCommand({}))
      const count = response.Buckets?.length ?? 0
      return { ok: true, detail: `${count} bucket${count === 1 ? '' : 's'} visible` }
    } catch (error) {
      return { ok: false, detail: describe(error) }
    }
  }

  client(provider: ProviderConfig): S3Client {
    return new S3Client({
      region: provider.region || 'us-east-1',
      endpoint: provider.endpoint || undefined,
      forcePathStyle: provider.forcePathStyle,
      credentials: {
        accessKeyId: provider.accessKeyId,
        secretAccessKey: provider.secretAccessKey,
        ...(provider.sessionToken ? { sessionToken: provider.sessionToken } : {}),
      },
      maxAttempts: 2,
      requestHandler: { requestTimeout: 20_000, connectionTimeout: 5_000 },
    })
  }

  private fromRow(row: ProviderRow): ProviderConfig {
    return {
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      region: row.region,
      forcePathStyle: row.force_path_style === 1,
      accessKeyId: row.access_key_id ?? '',
      secretAccessKey: this.vault.open(row.secret_ref),
      sessionToken: row.session_ref ? this.vault.open(row.session_ref) : null,
      scope: parseScope(row.scope_json),
    }
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    const named = error as Error & { $metadata?: { httpStatusCode?: number }; name?: string }
    const status = named.$metadata?.httpStatusCode
    return `${named.name ?? 'Error'}${status ? ` (${status})` : ''}: ${error.message.slice(0, 200)}`
  }
  return String(error).slice(0, 200)
}
