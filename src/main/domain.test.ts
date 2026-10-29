/**
 * The tools end to end: the real AWS SDK against a fake S3 over HTTP, the real
 * tools through `agentTool()`, a real SQLite file. No model and no window.
 */
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3Client } from '@aws-sdk/client-s3'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ToolDetails } from '@shared/contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeBucket, startFakeS3 } from '../../scripts/fake-s3.mjs'
import { AppDb } from './db'
import { Providers } from './providers'
import { readConfig, scrub } from './s3/raw'
import type { Vault } from './security/vault'
import { accountTool } from './tools/account'
import { bucketTools } from './tools/browse'
import { configTool } from './tools/config'
import { noteTool } from './tools/note'
import type { ToolDeps } from './tools/policy'
import { probeTool } from './tools/probe'

const BUCKETS: Record<string, FakeBucket> = {
  'aws-public': { public: true },
  'compat-public': { compat: true, public: true, encryption: true },
  'compat-narrowed': { compat: true, conditional: true, encryption: true },
  'acl-hidden': { aclDenied: true, encryption: true, blocked: true },
  'cors-open': { encryption: true, blocked: true, cors: '*', lifecycle: 'abort' },
  versioned: { encryption: true, blocked: true, versioning: true, lifecycle: 'expire' },
}

const vault = {
  seal: (v: string) => `sealed:${v}`,
  open: (v: string) => v.slice(7),
} as unknown as Vault

let fake: { server: Server; buckets: Record<string, FakeBucket>; endpoint: string }
let client: S3Client
let deps: ToolDeps
let providerId: string

interface Executable {
  execute: (
    args: never,
    api: never,
    context: never,
  ) => ReturnType<ReturnType<typeof configTool>['execute']>
}

async function run(tool: Executable, args: Record<string, unknown>, signal?: AbortSignal) {
  const result = await tool.execute(
    args as never,
    {
      conversationId: 'c1',
      output: () => undefined,
      details: async () => undefined,
    } as never,
    { abortSignal: signal } as never,
  )
  const text = result.output?.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? ''
  return {
    text,
    details: result.details as unknown as ToolDetails,
    isError: Boolean(result.isError),
  }
}

beforeAll(async () => {
  fake = await startFakeS3({ buckets: structuredClone(BUCKETS) })
  client = new S3Client({
    region: 'us-east-1',
    endpoint: fake.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'k', secretAccessKey: 's' },
  })
  const db = await AppDb.open(
    await openNodeSqliteDatabase(join(mkdtempSync(join(tmpdir(), 'sa-domain-')), 'db.sqlite')),
  )
  const providers = new Providers(db, vault)
  const account = await providers.save({
    name: 'Fake',
    endpoint: fake.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    auth: 'keys',
    accessKeyId: 'AKIAFAKEFAKEFAKEFAKE',
    secretAccessKey: 'secret',
    scope: { buckets: [] },
  })
  providerId = account.id
  deps = {
    db,
    providers,
    datasetsDir: () => tmpdir(),
    uploadsDir: () => tmpdir(),
    lang: () => 'en',
  }
})

afterAll(() => {
  fake.server.close()
})

type Sections = Record<string, { status: string; value?: unknown; error?: string }>

describe('one bucket, as S3 returns it', () => {
  it('returns each section with its status, and parses the policy', async () => {
    const read = await readConfig(client, 'aws-public', ['policy', 'policy_status', 'lifecycle'], {
      defaultRegion: 'us-east-1',
    })
    const sections = read.sections as Sections
    expect(sections.policy?.status).toBe('available')
    const policy = sections.policy?.value as { Statement?: { Principal?: unknown }[] }
    expect(policy.Statement?.[0]?.Principal).toBe('*')
    expect(sections.policy_status?.status).toBe('available')
    expect(sections.lifecycle).toEqual({ status: 'not_configured' })
  })

  it('says a section was denied, with the provider error, and reads the rest', async () => {
    const read = await readConfig(client, 'acl-hidden', ['acl', 'public_access_block'], {
      defaultRegion: 'us-east-1',
    })
    const sections = read.sections as Sections
    expect(sections.acl?.status).toBe('access_denied')
    expect(sections.acl?.error).toContain('AccessDenied')
    expect(sections.public_access_block?.status).toBe('available')
  })

  it('reports what a provider does not implement as unsupported', async () => {
    const read = await readConfig(client, 'compat-public', ['policy_status'], {
      defaultRegion: 'us-east-1',
    })
    expect((read.sections as Sections).policy_status?.status).toBe('provider_unsupported')
  })

  it('replaces account ids and drops SDK metadata', () => {
    expect(
      scrub({ $metadata: { httpStatusCode: 200 }, Owner: 'arn:aws:iam::123456789012:root' }),
    ).toEqual({ Owner: 'arn:aws:iam::<account>:root' })
  })
})

describe('tools', () => {
  it('sends the agent the configuration the window shows', async () => {
    const { text, details } = await run(configTool(deps), {
      bucket: 'cors-open',
      sections: ['cors', 'lifecycle'],
    })
    expect(details.status).toBe('done')
    if (details.view?.kind !== 'raw') throw new Error('expected a raw view')
    const sent = JSON.parse(
      /<untrusted-data[^>]*>\n?([\s\S]*?)\n?<\/untrusted-data>/.exec(text)?.[1] ?? '{}',
    )
    expect(sent.cors.status).toBe('available')
    expect(sent.lifecycle.status).toBe('available')
    expect(JSON.stringify(details.view.value)).toContain('AllowedOrigins')
  })

  it('lists every bucket the account holds', async () => {
    const [buckets] = bucketTools(deps)
    const { text, details } = await run(buckets as Executable, {})
    if (details.view?.kind !== 'buckets') throw new Error('expected a bucket listing')
    expect(details.view.rows.rows.map((row) => row[0])).toEqual(
      expect.arrayContaining(Object.keys(BUCKETS)),
    )
    for (const name of Object.keys(BUCKETS)) expect(text).toContain(name)
  })

  it('refuses a bucket outside the account scope before any request', async () => {
    await deps.providers.save({
      id: providerId,
      name: 'Fake',
      endpoint: fake.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      auth: 'keys',
      scope: { buckets: ['cors-open'] },
    })
    const { details, isError } = await run(configTool(deps), { bucket: 'aws-public' })
    expect(isError).toBe(true)
    expect(details.status).toBe('refused')
    await deps.providers.save({
      id: providerId,
      name: 'Fake',
      endpoint: fake.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      auth: 'keys',
      scope: { buckets: [] },
    })
  })

  it('refuses a probe bucket outside the account scope', async () => {
    await deps.providers.save({
      id: providerId,
      name: 'Fake',
      endpoint: fake.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      auth: 'keys',
      scope: { buckets: ['cors-open'] },
    })
    const { details, isError } = await run(probeTool(deps), {
      provider_id: providerId,
      bucket: 'aws-public',
      check: 'location',
    })
    expect(isError).toBe(true)
    expect(details.status).toBe('refused')
    await deps.providers.save({
      id: providerId,
      name: 'Fake',
      endpoint: fake.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      auth: 'keys',
      scope: { buckets: [] },
    })
  })

  it('pages a listing with the token it returns, and sends the agent every row it shows', async () => {
    const [, objects] = bucketTools(deps)
    const bucket = Object.keys(fake.buckets)[0]!
    const first = await run(objects as Executable, { bucket, limit: 1 })
    if (first.details.view?.kind !== 'objects') throw new Error('expected a listing')
    const key = String(first.details.view.rows.rows[0]?.[0])
    expect(first.text).toContain(key)
    const token = /next: (\S+)/.exec(first.text)?.[1]
    if (!token) throw new Error(`expected a next token: ${first.text}`)
    const second = await run(objects as Executable, { bucket, limit: 1, token })
    if (second.details.view?.kind !== 'objects') throw new Error('expected a listing')
    expect(second.details.view.rows.rows[0]?.[0]).not.toBe(key)
  })

  it('previews text whatever content type the object declares, and sends the agent the preview', async () => {
    const [, , object] = bucketTools(deps)
    const bucket = Object.keys(fake.buckets)[0]!
    const { text, details } = await run(object as Executable, {
      bucket,
      key: 'notes.txt',
      aspects: ['head', 'preview'],
    })
    if (details.view?.kind !== 'object') throw new Error(`expected an object view: ${text}`)
    expect(details.view.preview?.text).toBe('hello from the fake bucket')
    expect(text).toContain('hello from the fake bucket')
  })

  it('says account-level reads need AWS, without calling anything', async () => {
    const { details } = await run(accountTool(deps), { read: 'public_access_block' })
    expect(details.status).toBe('done')
    if (details.view?.kind !== 'raw') throw new Error('expected a raw view')
    expect(details.view.value).toMatchObject({ status: 'provider_unsupported' })
  })

  it('remembers a note without its secrets', async () => {
    const { details } = await run(noteTool(deps), {
      text: 'Logs land in cors-open. key AKIAABCDEFGHIJKLMNOP',
    })
    if (details.view?.kind !== 'note') throw new Error('expected a note view')
    expect(details.view.text).not.toContain('AKIAABCDEFGHIJKLMNOP')
    const notes = await deps.db.listNotes()
    expect(notes.some((note) => note.text.startsWith('Logs land in cors-open.'))).toBe(true)
  })

  it('reports a stopped call as stopped, not failed', async () => {
    const controller = new AbortController()
    controller.abort()
    const { details } = await run(configTool(deps), { bucket: 'versioned' }, controller.signal)
    expect(details.status).toBe('stopped')
  })
})
