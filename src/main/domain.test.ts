/**
 * The tools end to end: the real AWS SDK against a fake S3 over HTTP, the real
 * tools through `agentTool()`, a real SQLite file. No model and no window.
 */
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ToolDetails } from '@shared/contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeBucket, startFakeS3 } from '../../scripts/fake-s3.mjs'
import { AppDb } from './db'
import { MemoryStore } from './memory'
import { Providers } from './providers'
import { checkCall, operationsOf, scrub } from './s3/api'
import type { Vault } from './security/vault'
import { callTool } from './tools/call'
import { memoryTool } from './tools/memory'
import { moreTool } from './tools/more'
import { PIECE, type ToolDeps } from './tools/policy'

const BUCKETS: Record<string, FakeBucket> = {
  'aws-public': { public: true },
  'compat-public': { compat: true, public: true, encryption: true },
  'acl-hidden': { aclDenied: true, encryption: true, blocked: true },
  'cors-open': { encryption: true, blocked: true, cors: '*', lifecycle: 'abort' },
  big: { encryption: true, objects: { count: 3000, prefixes: ['a/', 'b/'] } },
}

const vault = {
  seal: (v: string) => `sealed:${v}`,
  open: (v: string) => v.slice(7),
} as unknown as Vault

let fake: { server: Server; buckets: Record<string, FakeBucket>; endpoint: string }
let deps: ToolDeps
let providerId: string
const taskDir = mkdtempSync(join(tmpdir(), 'sa-task-'))

interface Executable {
  execute: (
    args: never,
    api: never,
    context: never,
  ) => ReturnType<ReturnType<typeof callTool>['execute']>
}

let calls = 0

async function run(tool: Executable, args: Record<string, unknown>, signal?: AbortSignal) {
  const result = await tool.execute(
    args as never,
    {
      conversationId: 'c1',
      callId: `call-${++calls}`,
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
    memory: MemoryStore.open(join(taskDir, 'memory.sqlite')),
    taskDir: () => taskDir,
    datasetsDir: () => tmpdir(),
    uploadsDir: () => tmpdir(),
    lang: () => 'en',
  }
})

afterAll(() => {
  fake.server.close()
})

const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
  run(callTool(deps), args, signal)

/** What the agent received, out of its envelope. */
const sent = (text: string) =>
  /<untrusted-data[^>]*>\n?([\s\S]*?)\n?<\/untrusted-data>/.exec(text)?.[1] ?? ''

describe('one read-only call', () => {
  it('runs any read a service offers and returns what it answered', async () => {
    const { text, details } = await call({ service: 's3', operation: 'ListBuckets' })
    expect(details.status).toBe('done')
    const value = JSON.parse(sent(text)) as { Buckets: { Name: string }[] }
    expect(value.Buckets.map((item) => item.Name)).toEqual(
      expect.arrayContaining(Object.keys(BUCKETS)),
    )
    if (details.view?.kind !== 'raw') throw new Error('expected a raw view')
    expect(details.view.title).toBe('s3 ListBuckets')
  })

  it('parses a policy document the service returns as a string', async () => {
    const { text } = await call({
      service: 's3',
      operation: 'GetBucketPolicy',
      input: { Bucket: 'aws-public' },
    })
    const value = JSON.parse(sent(text)) as { Policy: { Statement: { Principal: unknown }[] } }
    expect(value.Policy.Statement[0]?.Principal).toBe('*')
  })

  it("returns the service's error code and HTTP status when a call fails", async () => {
    const denied = await call({
      service: 's3',
      operation: 'GetBucketAcl',
      input: { Bucket: 'acl-hidden' },
    })
    expect(denied.details.status).toBe('failed')
    expect(sent(denied.text)).toMatch(/AccessDenied \(HTTP 403\)/)
    const unsupported = await call({
      service: 's3',
      operation: 'GetBucketPolicyStatus',
      input: { Bucket: 'compat-public' },
    })
    expect(sent(unsupported.text)).toMatch(/HTTP 501/)
  })

  it('reads an object body as text, up to the bytes asked for', async () => {
    const all = await call({
      service: 's3',
      operation: 'GetObject',
      input: { Bucket: 'cors-open', Key: 'notes.txt' },
    })
    expect(JSON.parse(sent(all.text)).Body).toMatchObject({ text: 'hello from the fake bucket' })
    const part = await call({
      service: 's3',
      operation: 'GetObject',
      input: { Bucket: 'cors-open', Key: 'notes.txt' },
      max_bytes: 5,
    })
    expect(JSON.parse(sent(part.text)).Body).toMatchObject({ text: 'hello', more: true })
  })

  it('streams a body to the task folder and reads it back with more', async () => {
    const all = await call({
      service: 's3',
      operation: 'GetObject',
      input: { Bucket: 'cors-open', Key: 'notes.txt' },
    })
    const body = JSON.parse(sent(all.text)) as { Body: { ref?: string; text?: string } }
    expect(body.Body.text).toBe('hello from the fake bucket')
    expect(body.Body.ref).toMatch(/^objects\//)
    const next = await run(moreTool(deps), { evidence: body.Body.ref!, offset: 0 })
    expect(next.details.status).toBe('done')
    expect(sent(next.text)).toContain('hello from the fake bucket')
    const fromSix = await run(moreTool(deps), { evidence: body.Body.ref!, offset: 6 })
    expect(sent(fromSix.text)).toMatch(/^from the fake bucket/)
  })

  it('refuses anything that is not a read, before any request', () => {
    const config = { scope: { buckets: [] } } as never
    expect(() => checkCall(config, { service: 's3', operation: 'PutObject' })).toThrow(/not a read/)
    expect(() => checkCall(config, { service: 's3', operation: 'DeleteBucket' })).toThrow(
      /not a read/,
    )
    expect(() => checkCall(config, { service: 'sts', operation: 'GetSessionToken' })).toThrow(
      /not a read/,
    )
    expect(() =>
      checkCall(config, { service: 'secretsmanager', operation: 'GetSecretValue' }),
    ).toThrow(/not a read/)
    expect(() => checkCall(config, { service: 'ssm', operation: 'GetParameter' })).toThrow(
      /not a read/,
    )
    expect(() => checkCall(config, { service: 'ecr', operation: 'GetAuthorizationToken' })).toThrow(
      /not a read/,
    )
    expect(() => checkCall(config, { service: 'dynamodb', operation: 'Query' })).not.toThrow()
    expect(() => checkCall(config, { service: 'dynamodb', operation: 'Scan' })).not.toThrow()
    expect(operationsOf('dynamodb')).toEqual(expect.arrayContaining(['Query', 'Scan']))
    expect(() => checkCall(config, { service: 's3', operation: 'GetNothing' })).toThrow(
      /no operation/,
    )
    const scoped = { scope: { buckets: ['logs'] } } as never
    expect(() =>
      checkCall(scoped, {
        service: 's3',
        operation: 'ListObjectsV2',
        input: { Bucket: 'arn:aws:s3:us-east-1:<account>:accesspoint/all' },
      }),
    ).toThrow(/outside this account's scope/)
    expect(() =>
      checkCall(scoped, {
        service: 's3',
        operation: 'ListObjectsV2',
        input: { Bucket: 'arn:aws:s3:::logs' },
      }),
    ).not.toThrow()
    expect(operationsOf('s3')).toContain('GetBucketLifecycleConfiguration')
    expect(operationsOf('s3').every((name) => /^(Get|List|Head|Select)/.test(name))).toBe(true)
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
    const refused = await call({
      service: 's3',
      operation: 'GetBucketPolicy',
      input: { Bucket: 'aws-public' },
    })
    expect(refused.details.status).toBe('refused')
    // A listing shows only what the scope allows.
    const listed = await call({ service: 's3', operation: 'ListBuckets' })
    const names = (JSON.parse(sent(listed.text)) as { Buckets: { Name: string }[] }).Buckets.map(
      (item) => item.Name,
    )
    expect(names).toEqual(['cors-open'])
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

  it('replaces account ids and drops SDK metadata', () => {
    expect(
      scrub({ $metadata: { httpStatusCode: 200 }, Owner: 'arn:aws:iam::123456789012:root' }),
    ).toEqual({ Owner: 'arn:aws:iam::<account>:root' })
  })

  it('keeps a 12-digit object key or value that is not the account id', () => {
    expect(scrub({ key: '123456789012', body: 'at 202610291234' })).toEqual({
      key: '123456789012',
      body: 'at 202610291234',
    })
  })

  it('removes an account id named as a policy principal', () => {
    expect(scrub({ Principal: { AWS: '999999999999' }, key: '999999999999' })).toEqual({
      Principal: { AWS: '<account>' },
      key: '999999999999',
    })
  })

  it('reports a stopped call as stopped, not failed', async () => {
    const controller = new AbortController()
    controller.abort()
    const { details } = await call({ service: 's3', operation: 'ListBuckets' }, controller.signal)
    expect(details.status).toBe('stopped')
  })
})

describe('a result longer than one piece', () => {
  it('sends the first piece and keeps the rest for `more`', async () => {
    const first = await call({
      service: 's3',
      operation: 'ListObjectsV2',
      input: { Bucket: 'big' },
    })
    const piece = sent(first.text)
    expect(piece).toMatch(/more characters\. Read them with `more`/)
    const evidence = /evidence "([^"]+)"/.exec(piece)?.[1]
    const offset = Number(/offset (\d+)/.exec(piece)?.[1])
    expect(offset).toBe(PIECE)
    if (!evidence) throw new Error(`no evidence id in: ${piece.slice(-200)}`)
    const next = await run(moreTool(deps), { evidence, offset })
    expect(next.details.status).toBe('done')
    expect(sent(next.text).length).toBeGreaterThan(0)
  })
})

describe('memory', () => {
  it('remembers JSON without its secrets, lists it, and forgets it', async () => {
    const { details } = await run(memoryTool(deps), {
      action: 'put',
      key: 'logs',
      value: { bucket: 'cors-open', key: 'AKIA1234567890123456' },
      text: 'Logs land in cors-open. key AKIA1234567890123456',
    })
    expect(details.status).toBe('done')
    const mine = deps.memory?.get('logs')
    expect(mine?.value).toMatchObject({ bucket: 'cors-open' })
    expect(JSON.stringify(mine?.value)).not.toContain('AKIA1234567890123456')
    const list = await run(memoryTool(deps), { action: 'list' })
    expect(list.details.status).toBe('done')
    const forgot = await run(memoryTool(deps), { action: 'delete', key: 'logs' })
    expect(forgot.details.status).toBe('done')
    expect(deps.memory?.get('logs')).toBeNull()
  })
})
