/**
 * One read-only API call, as the service answers it.
 *
 * The agent names a service the app bundles, an operation and its input; this
 * module checks that the operation only reads, keeps S3 inside the account's
 * bucket scope, puts the caller's account id where the agent wrote
 * `<account>`, and returns the response with every account id scrubbed.
 * Nothing here decides what a response means.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as accessanalyzer from '@aws-sdk/client-accessanalyzer'
import * as backup from '@aws-sdk/client-backup'
import * as cloudfront from '@aws-sdk/client-cloudfront'
import * as cloudtrail from '@aws-sdk/client-cloudtrail'
import * as cloudwatch from '@aws-sdk/client-cloudwatch'
import * as config from '@aws-sdk/client-config-service'
import * as guardduty from '@aws-sdk/client-guardduty'
import * as iam from '@aws-sdk/client-iam'
import * as kms from '@aws-sdk/client-kms'
import * as organizations from '@aws-sdk/client-organizations'
import * as s3 from '@aws-sdk/client-s3'
import * as s3control from '@aws-sdk/client-s3-control'
import * as securityhub from '@aws-sdk/client-securityhub'
import * as sns from '@aws-sdk/client-sns'
import * as sqs from '@aws-sdk/client-sqs'
import * as sts from '@aws-sdk/client-sts'
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import type { ProviderConfig, Providers } from '../providers'
import { redact } from '../security/redact'
import { ScopeError } from '../security/scope'

/** The service modules the app bundles; each exports `<Operation>Command` classes. */
const MODULES: Record<string, Record<string, unknown>> = {
  s3,
  s3control,
  sts,
  iam,
  organizations,
  kms,
  accessanalyzer,
  cloudwatch,
  cloudtrail,
  cloudfront,
  config,
  securityhub,
  guardduty,
  sns,
  sqs,
  backup,
}

export const SERVICES = Object.keys(MODULES)

/** Operations whose names say they read. */
const READ = /^(?:Get|List|Head|Describe|Lookup|Search|Select|Simulate|BatchGet)(?:[A-Z]|$)/

/**
 * Reads that hand out credentials or start state on the service side. They
 * read nothing about the storage; the agent never needs them.
 */
const NEVER = new Set([
  'sts:GetSessionToken',
  'sts:GetFederationToken',
  'sts:GetWebIdentityToken',
  'sts:GetDelegatedAccessToken',
  'kms:GetParametersForImport',
])

/** Every operation a service offers, for the error that names a wrong one. */
export function operationsOf(service: string): string[] {
  return Object.keys(MODULES[service] ?? {})
    .filter((name) => name.endsWith('Command') && name !== 'Command')
    .map((name) => name.slice(0, -'Command'.length))
    .filter((name) => READ.test(name) && !NEVER.has(`${service}:${name}`))
    .sort()
}

/** The member names of an operation's input and output, as the bundled SDK models them. */
export function operationShape(
  service: string,
  operation: string,
): { input: string[] | null; output: string[] | null } {
  const module = MODULES[service] ?? {}
  const members = (...names: string[]): string[] | null => {
    for (const name of names) {
      const shape = module[`${name}$`]
      if (Array.isArray(shape) && Array.isArray(shape[4])) return shape[4] as string[]
    }
    return null
  }
  return {
    input: members(`${operation}Request`, `${operation}Input`),
    output: members(`${operation}Output`, `${operation}Response`, `${operation}Result`),
  }
}

/**
 * Every 12-digit number in a value becomes `<account>`, keys included: an
 * account id never reaches the model, whichever account it names. ARNs are
 * masked by `redact`.
 */
export function scrub(value: unknown): unknown {
  if (typeof value === 'string')
    return redact(value)
      .replaceAll('[account]', '<account>')
      .replace(/\b\d{12}\b/g, '<account>')
  if (Array.isArray(value)) return value.map(scrub)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString('base64') }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== '$metadata')
        .map(([key, item]) => [scrub(key) as string, scrub(item)]),
    )
  return value
}

const POLICY_KEY = /(policy|document|statement|assumerole)/i

/**
 * A policy document arrives as a JSON string, IAM's URL-encoded. Parse only a
 * field whose name says it is a policy; an object body that happens to be JSON
 * stays text.
 */
function documents(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (!POLICY_KEY.test(key)) return value
    const text = /^%7B/i.test(value) ? safeDecode(value) : value
    if (/^\s*[{[]/.test(text))
      try {
        return JSON.parse(text)
      } catch {
        return value
      }
    return value
  }
  if (Array.isArray(value)) return value.map((item) => documents(item, key))
  if (
    value &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  )
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        documents(item, name),
      ]),
    )
  return value
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Put the caller's account id wherever the input says `<account>`. */
function withAccount(value: unknown, account: string): unknown {
  if (typeof value === 'string') return value.replaceAll('<account>', account)
  if (Array.isArray(value)) return value.map((item) => withAccount(item, account))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        withAccount(item, account),
      ]),
    )
  return value
}

function mentionsAccount(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('<account>')
}

/**
 * What one body read holds unless the agent asks for more: it protects the
 * user's disk and memory, not the agent's reach. `max_bytes` changes it, and a
 * `Range` reads any part of an object.
 */
export const DEFAULT_BODY_BYTES = 1024 * 1024

/** A body is streamed to the task folder, never held whole in memory. */
async function readBody(
  body: AsyncIterable<Uint8Array> & { destroy?: () => void },
  maxBytes: number,
  bodyDir?: string,
  full = false,
): Promise<{
  ref?: string
  bytesRead: number
  text?: string
  base64?: string
  more?: boolean
}> {
  if (!bodyDir) {
    const chunks: Uint8Array[] = []
    let size = 0
    let more = false
    for await (const chunk of body) {
      const room = maxBytes - size
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room))
        size += Math.max(0, room)
        more = true
        body.destroy?.()
        break
      }
      chunks.push(chunk)
      size += chunk.length
    }
    const bytes = Buffer.concat(chunks)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const binary =
      text.includes('\u0000') ||
      (text.match(/\uFFFD/g)?.length ?? 0) > Math.max(4, text.length / 50)
    return {
      bytesRead: bytes.length,
      ...(binary ? { base64: bytes.toString('base64') } : { text }),
      ...(more ? { more: true } : {}),
    }
  }

  const folder = join(bodyDir, 'objects')
  await mkdir(folder, { recursive: true })
  const ref = `objects/${randomUUID()}.bin`
  const path = join(bodyDir, ref)
  const handle = await open(path, 'w')
  const previewLimit = 64 * 1024
  let preview = Buffer.alloc(0)
  let size = 0
  let more = false
  try {
    for await (const chunk of body) {
      const room = maxBytes - size
      if (chunk.length > room) {
        const take = chunk.subarray(0, Math.max(0, room))
        if (take.length) {
          await handle.write(take)
          if (preview.length < previewLimit)
            preview = Buffer.concat([preview, take.subarray(0, previewLimit - preview.length)])
        }
        size += take.length
        more = true
        body.destroy?.()
        break
      }
      await handle.write(chunk)
      size += chunk.length
      if (preview.length < previewLimit)
        preview = Buffer.concat([preview, chunk.subarray(0, previewLimit - preview.length)])
    }
  } finally {
    await handle.close()
  }
  if (full) {
    const bytes = await readFile(path)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const binary =
      text.includes('\u0000') ||
      (text.match(/\uFFFD/g)?.length ?? 0) > Math.max(4, text.length / 50)
    return {
      ref,
      bytesRead: bytes.length,
      ...(binary ? { base64: bytes.toString('base64') } : { text }),
    }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(preview)
  const binary =
    text.includes('\u0000') || (text.match(/\uFFFD/g)?.length ?? 0) > Math.max(4, text.length / 50)
  return {
    ref,
    bytesRead: size,
    ...(binary ? { base64: preview.toString('base64') } : { text }),
    ...(more ? { more: true } : {}),
  }
}

/** An event stream: record payloads joined as text up to `maxBytes`, other events as they came. */
async function readEvents(
  events: AsyncIterable<Record<string, unknown>>,
  maxBytes: number,
): Promise<{ records: string; events: unknown[]; more?: boolean }> {
  const chunks: Buffer[] = []
  const other: unknown[] = []
  let size = 0
  let more = false
  for await (const event of events) {
    const payload = (event.Records as { Payload?: Uint8Array } | undefined)?.Payload
    if (!payload) {
      other.push(event)
      continue
    }
    const room = maxBytes - size
    if (payload.length > room) {
      chunks.push(Buffer.from(payload.subarray(0, Math.max(0, room))))
      size = maxBytes
      more = true
      break
    }
    chunks.push(Buffer.from(payload))
    size += payload.length
  }
  return {
    records: Buffer.concat(chunks).toString('utf8'),
    events: other,
    ...(more ? { more: true } : {}),
  }
}

export interface CallInput {
  service: string
  operation: string
  input?: Record<string, unknown>
  region?: string
  /** For a streamed body (GetObject): read at most this many bytes (default 1 MiB). */
  maxBytes?: number
  /** Internal: read the whole body for an inventory manifest. */
  fullBody?: boolean
}

export interface CallDeps {
  providers: Providers
  config: ProviderConfig
  signal?: AbortSignal
  /** The task folder for streamed object bodies. */
  bodyDir?: string
}

/** Check a call before anything is sent. Throws with the reason a call does not run. */
export function checkCall(config: ProviderConfig, call: CallInput): void {
  const service = String(call.service ?? '').toLowerCase()
  if (!MODULES[service]) throw new Error(`service must be one of ${SERVICES.join(', ')}.`)
  const operation = String(call.operation ?? '')
  if (!READ.test(operation) || NEVER.has(`${service}:${operation}`))
    throw new ScopeError(
      `${service}:${operation} is not a read this app runs. This app only reads: operations named Get, List, Head, Describe, Lookup, Search, Select, Simulate or BatchGet, except the few that hand out credentials.`,
    )
  if (typeof MODULES[service]?.[`${operation}Command`] !== 'function')
    throw new Error(
      `${service} has no operation ${operation}. Its reads: ${operationsOf(service).join(', ')}.`,
    )
  const bucket = (call.input as { Bucket?: unknown } | undefined)?.Bucket
  const scope = config.scope.buckets
  if (
    (service === 's3' || service === 's3control') &&
    typeof bucket === 'string' &&
    bucket &&
    scope.length
  ) {
    // A scoped account reads only buckets it names: a plain name, or a plain bucket ARN.
    // An access point or outpost ARN reaches buckets the scope cannot see, so it does not run.
    const name =
      /^arn:[^:]+:s3:::([^/]+)$/.exec(bucket)?.[1] ?? (bucket.startsWith('arn:') ? null : bucket)
    if (!name || !scope.includes(name))
      throw new ScopeError(
        `Bucket "${bucket}" is outside this account's scope (${scope.join(', ')}).`,
      )
  }
}

/** Run one read-only call and return its response, scrubbed. */
export async function callApi(deps: CallDeps, call: CallInput): Promise<unknown> {
  const { providers, config, signal } = deps
  checkCall(config, call)
  const service = call.service.toLowerCase()
  const Command = MODULES[service]![`${call.operation}Command`] as new (input: unknown) => unknown
  let input: Record<string, unknown> = { ...(call.input ?? {}) }
  // The agent never sees the account id; S3 Control needs it on every call.
  const needsAccount = service === 's3control' && input.AccountId === undefined
  if (needsAccount || mentionsAccount(input)) {
    const identity = await providers
      .sts(config)
      .send(new GetCallerIdentityCommand({}), { abortSignal: signal })
    if (!identity.Account) throw new Error('STS returned no account id.')
    if (needsAccount) input.AccountId = identity.Account
    input = withAccount(input, identity.Account) as Record<string, unknown>
  }
  const region = call.region || config.region || 'us-east-1'
  const client = providers.clientFor(config, service, region)
  const response = (await client.send(new Command(input) as never, {
    abortSignal: signal,
  })) as Record<string, unknown>
  const out: Record<string, unknown> = { ...response }
  const body = out.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined
  if (body && typeof body[Symbol.asyncIterator] === 'function')
    out.Body = await readBody(
      body,
      call.fullBody ? Number.POSITIVE_INFINITY : (call.maxBytes ?? DEFAULT_BODY_BYTES),
      deps.bodyDir,
      call.fullBody,
    )
  // SelectObjectContent answers with an event stream: the records as text, the rest as events.
  const events = out.Payload as AsyncIterable<Record<string, unknown>> | undefined
  if (events && typeof events[Symbol.asyncIterator] === 'function')
    out.Payload = await readEvents(events, call.maxBytes ?? DEFAULT_BODY_BYTES)
  // An S3 listing shows only the buckets this account may read.
  if (service === 's3' && call.operation === 'ListBuckets' && Array.isArray(out.Buckets)) {
    const scope = config.scope.buckets
    if (scope.length)
      out.Buckets = (out.Buckets as { Name?: string }[]).filter(
        (item) => item.Name && scope.includes(item.Name),
      )
  }
  return scrub(documents(out))
}

/**
 * An error as one line, account scrubbed. A service's error keeps its code and
 * HTTP status, which is what the agent reads to know what happened.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return scrub(String(error)) as string
  const named = error as Error & { $metadata?: { httpStatusCode?: number }; Code?: string }
  if (!named.$metadata) return scrub(error.message) as string
  const code = named.Code ?? named.name
  const http = named.$metadata?.httpStatusCode
  return scrub(`${code}${http ? ` (HTTP ${http})` : ''}: ${error.message}`) as string
}
