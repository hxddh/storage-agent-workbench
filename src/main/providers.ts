import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AccessAnalyzerClient } from '@aws-sdk/client-accessanalyzer'
import { BackupClient } from '@aws-sdk/client-backup'
import { CloudFrontClient } from '@aws-sdk/client-cloudfront'
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail'
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { ConfigServiceClient } from '@aws-sdk/client-config-service'
import { GuardDutyClient } from '@aws-sdk/client-guardduty'
import { IAMClient } from '@aws-sdk/client-iam'
import { KMSClient } from '@aws-sdk/client-kms'
import { OrganizationsClient } from '@aws-sdk/client-organizations'
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3'
import { S3ControlClient } from '@aws-sdk/client-s3-control'
import { SecurityHubClient } from '@aws-sdk/client-securityhub'
import { SNSClient } from '@aws-sdk/client-sns'
import { SQSClient } from '@aws-sdk/client-sqs'
import { STSClient } from '@aws-sdk/client-sts'
import { fromIni } from '@aws-sdk/credential-provider-ini'
import type { Account, AccountInput } from '@shared/contract'
import type { AppDb, ProviderRow } from './db'
import { scrub } from './s3/api'
import { maskKey } from './security/redact'
import type { Vault } from './security/vault'

export type Credentials =
  | { kind: 'keys'; accessKeyId: string; secretAccessKey: string; sessionToken: string | null }
  | { kind: 'profile'; profile: string }

export interface ProviderConfig {
  id: string
  name: string
  endpoint: string
  region: string
  forcePathStyle: boolean
  credentials: Credentials
  scope: { buckets: string[] }
}

function parseScope(json: string): { buckets: string[] } {
  try {
    const value = JSON.parse(json) as { buckets?: unknown }
    return {
      buckets: Array.isArray(value.buckets)
        ? value.buckets.filter((b): b is string => typeof b === 'string')
        : [],
    }
  } catch {
    return { buckets: [] }
  }
}

/**
 * Profile names from the shared AWS config and credentials files. Names only:
 * the files are never parsed for keys here; the SDK resolves a profile itself.
 */
export function awsProfiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set<string>()
  const read = (path: string, prefixed: boolean) => {
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*\[([^\]]+)\]\s*$/.exec(line)
      if (!match) continue
      let name = match[1]!.trim()
      if (prefixed) {
        if (name.startsWith('profile ')) name = name.slice(8).trim()
        else if (name !== 'default') continue
      }
      if (name && /^[\w.@+-]{1,128}$/.test(name)) names.add(name)
    }
  }
  read(env.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config'), true)
  read(env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), '.aws', 'credentials'), false)
  return [...names].sort((a, b) =>
    a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b),
  )
}

/**
 * S3 Control puts the account id in the host name (`<account>.s3-control…`); a
 * custom endpoint on an address cannot answer that, so its endpoint is fixed.
 */
export function emulatorControl(
  options: Record<string, unknown>,
  endpoint: string,
): S3ControlClient {
  return new S3ControlClient({ ...options, endpointProvider: () => ({ url: new URL(endpoint) }) })
}

/** Any bundled service client: they all send commands and can be destroyed. */
export interface Client {
  send(command: never, options?: { abortSignal?: AbortSignal }): Promise<unknown>
  destroy(): void
}

const SERVICE_CLIENTS: Record<string, (options: Record<string, unknown>) => Client> = {
  s3control: (o) => new S3ControlClient(o),
  sts: (o) => new STSClient(o),
  iam: (o) => new IAMClient(o),
  organizations: (o) => new OrganizationsClient(o),
  kms: (o) => new KMSClient(o),
  accessanalyzer: (o) => new AccessAnalyzerClient(o),
  cloudwatch: (o) => new CloudWatchClient(o),
  cloudtrail: (o) => new CloudTrailClient(o),
  cloudfront: (o) => new CloudFrontClient(o),
  config: (o) => new ConfigServiceClient(o),
  securityhub: (o) => new SecurityHubClient(o),
  guardduty: (o) => new GuardDutyClient(o),
  sns: (o) => new SNSClient(o),
  sqs: (o) => new SQSClient(o),
  backup: (o) => new BackupClient(o),
}

const GLOBAL = new Set(['iam', 'organizations', 'route53', 'cloudfront', 'support', 'costexplorer'])

export class Providers {
  private readonly names = new Map<string, { at: number; names: string[] }>()
  private readonly clients = new Map<string, S3Client>()
  private readonly services = new Map<string, Client>()

  constructor(
    private readonly db: AppDb,
    private readonly vault: Vault,
  ) {}

  async list(): Promise<Account[]> {
    const rows = await this.db.listProviders()
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      region: row.region,
      forcePathStyle: row.force_path_style === 1,
      auth: row.auth === 'profile' ? 'profile' : 'keys',
      profile: row.profile ?? null,
      accessKeyMasked: row.auth === 'profile' ? '' : maskKey(row.access_key_id),
      hasSessionToken: Boolean(row.session_ref),
      scope: parseScope(row.scope_json),
    }))
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
    const auth = input.auth === 'profile' ? 'profile' : 'keys'
    let secretRef = ''
    let sessionRef: string | null = null
    let accessKeyId: string | null = null
    let profile: string | null = null
    if (auth === 'profile') {
      profile = input.profile?.trim() || null
      if (!profile) throw new Error('Choose an AWS profile.')
    } else {
      const secret = input.secretAccessKey?.trim()
      const keep = existing?.auth !== 'profile'
      secretRef = secret ? this.vault.seal(secret) : keep ? (existing?.secret_ref ?? '') : ''
      if (!secretRef) throw new Error('A secret access key is required.')
      sessionRef = input.sessionToken?.trim()
        ? this.vault.seal(input.sessionToken.trim())
        : keep
          ? (existing?.session_ref ?? null)
          : null
      accessKeyId = input.accessKeyId?.trim() || (keep ? existing?.access_key_id : null) || null
      if (!accessKeyId) throw new Error('An access key id is required.')
    }
    await this.db.upsertProvider({
      id,
      name: input.name.trim() || 'Storage',
      endpoint: input.endpoint.trim(),
      region: input.region.trim() || 'us-east-1',
      force_path_style: input.forcePathStyle ? 1 : 0,
      access_key_id: accessKeyId,
      secret_ref: secretRef,
      session_ref: sessionRef,
      scope_json: JSON.stringify({ buckets: input.scope.buckets.filter(Boolean) }),
      created_at: existing?.created_at ?? new Date().toISOString(),
      auth,
      profile,
    })
    this.forget(id)
    const account = (await this.list()).find((a) => a.id === id)
    if (!account) throw new Error('The account could not be saved.')
    return account
  }

  /** The bucket names an account lists now, within its scope; cached for a minute. */
  async bucketNames(id: string): Promise<string[]> {
    const cached = this.names.get(id)
    if (cached && Date.now() - cached.at < 60_000) return cached.names
    const config = await this.config(id)
    const response = await this.client(config).send(new ListBucketsCommand({}))
    const names = (response.Buckets ?? [])
      .map((bucket) => bucket.Name ?? '')
      .filter(
        (name) => name && (!config.scope.buckets.length || config.scope.buckets.includes(name)),
      )
    this.names.set(id, { at: Date.now(), names })
    return names
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteProvider(id)
    this.forget(id)
  }

  async test(id: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const provider = await this.config(id)
      const response = await this.client(provider).send(new ListBucketsCommand({}))
      const count = response.Buckets?.length ?? 0
      return { ok: true, detail: `${count} bucket${count === 1 ? '' : 's'} visible` }
    } catch (error) {
      return { ok: false, detail: describe(error) }
    }
  }

  /**
   * One client per account and region. Clients follow region redirects, so a
   * multi-region AWS account reads every bucket from its own region.
   */
  client(provider: ProviderConfig, region?: string): S3Client {
    const target = region || provider.region || 'us-east-1'
    // Addressing is part of the client identity: probe deliberately builds the
    // same account/region twice with different path-style settings.
    const key = `${provider.id}:${target}:${provider.forcePathStyle ? 'path' : 'virtual'}`
    const cached = this.clients.get(key)
    if (cached) return cached
    const credentials = this.credentialsOf(provider)
    const client = new S3Client({
      region: target,
      endpoint: provider.endpoint || undefined,
      forcePathStyle: provider.forcePathStyle,
      followRegionRedirects: true,
      credentials,
      maxAttempts: 2,
    })
    this.clients.set(key, client)
    return client
  }

  private credentialsOf(provider: ProviderConfig) {
    return provider.credentials.kind === 'profile'
      ? fromIni({ profile: provider.credentials.profile })
      : {
          accessKeyId: provider.credentials.accessKeyId,
          secretAccessKey: provider.credentials.secretAccessKey,
          ...(provider.credentials.sessionToken
            ? { sessionToken: provider.credentials.sessionToken }
            : {}),
        }
  }

  /**
   * The client of one bundled service for an account and region. A custom
   * endpoint answers every service itself (or says it does not implement it);
   * its credentials are never sent to AWS.
   */
  clientFor(provider: ProviderConfig, service: string, region: string): Client {
    if (service === 's3') return this.client(provider, region)
    const make = SERVICE_CLIENTS[service]
    if (!make) throw new Error(`Unknown service ${service}.`)
    // IAM and Organizations are global on AWS; their one endpoint is us-east-1.
    const target = !provider.endpoint && GLOBAL.has(service) ? 'us-east-1' : region
    const key = `${provider.id}:${service}:${target}`
    const cached = this.services.get(key)
    if (cached) return cached
    const endpoint = provider.endpoint || undefined
    const options: Record<string, unknown> = {
      region: target,
      credentials: this.credentialsOf(provider),
      maxAttempts: 3,
      ...(endpoint ? { endpoint } : {}),
    }
    const client =
      service === 's3control' && endpoint ? emulatorControl(options, endpoint) : make(options)
    this.services.set(key, client)
    return client
  }

  sts(provider: ProviderConfig): STSClient {
    return this.clientFor(provider, 'sts', provider.region || 'us-east-1') as STSClient
  }

  /** The regional client factory a reading uses; a custom endpoint has one region. */
  regional(provider: ProviderConfig): ((region: string) => S3Client) | undefined {
    if (provider.endpoint) return undefined
    return (region: string) => this.client(provider, region)
  }

  private forget(id: string): void {
    this.names.delete(id)
    for (const map of [this.clients, this.services] as Map<string, { destroy(): void }>[]) {
      for (const [key, client] of map) {
        if (key.startsWith(`${id}:`)) {
          client.destroy()
          map.delete(key)
        }
      }
    }
  }

  private fromRow(row: ProviderRow): ProviderConfig {
    return {
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      region: row.region,
      forcePathStyle: row.force_path_style === 1,
      credentials:
        row.auth === 'profile'
          ? { kind: 'profile', profile: row.profile ?? 'default' }
          : {
              kind: 'keys',
              accessKeyId: row.access_key_id ?? '',
              secretAccessKey: this.vault.open(row.secret_ref),
              sessionToken: row.session_ref ? this.vault.open(row.session_ref) : null,
            },
      scope: parseScope(row.scope_json),
    }
  }
}

/** A provider error as one line; the account id it may name becomes `<account>`. */
export function describe(error: unknown): string {
  return scrub(describeRaw(error)) as string
}

function describeRaw(error: unknown): string {
  if (error instanceof Error) {
    const named = error as Error & { $metadata?: { httpStatusCode?: number }; name?: string }
    const status = named.$metadata?.httpStatusCode
    if (/sso|token.*expired|refresh/i.test(error.message) && named.name !== 'AccessDenied') {
      return `${named.name ?? 'Error'}: ${error.message.slice(0, 160)} — run \`aws sso login\` for this profile.`
    }
    return `${named.name ?? 'Error'}${status ? ` (${status})` : ''}: ${error.message.slice(0, 200)}`
  }
  return String(error).slice(0, 200)
}
