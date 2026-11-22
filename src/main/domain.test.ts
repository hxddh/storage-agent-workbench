/**
 * The tools end to end: the real AWS SDK against a fake S3 over HTTP, the real
 * tools through `agentTool()`, a real SQLite file. No model and no window.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ToolDetails } from '@shared/contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeBucket, startFakeS3 } from '../../scripts/fake-s3.mjs'
import { AppDb } from './db'
import { Providers } from './providers'
import { checkCall, operationsOf, shape } from './s3/api'
import type { Vault } from './security/vault'
import { callTool } from './tools/call'
import { moreTool } from './tools/more'
import { PIECE, type ToolDeps } from './tools/policy'
import { isPublicAddress, probeTool } from './tools/probe'
import { Workspace } from './workspace'

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

const uploads = mkdtempSync(join(tmpdir(), 'sa-uploads-'))

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
    workspace: new Workspace(join(taskDir, 'workspace')),
    taskDir: () => taskDir,
    datasetsDir: () => tmpdir(),
    userDatasetsDir: join(taskDir, 'user-datasets'),
    uploadsDir: () => uploads,
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
  /<untrusted-data[^>]*>\n?([\s\S]*?)\n?<\/untrusted-data[^>]*>/.exec(text)?.[1] ?? ''

describe('what the task holds', () => {
  it('ends a text piece on a line, so a secret is never redacted in halves', async () => {
    writeFileSync(
      join(uploads, 'creds.ini'),
      '[default]\naws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\nregion = eu-west-1\n',
    )
    const part = await run(moreTool(deps), { evidence: 'attachment:creds.ini', length: 30 })
    expect(sent(part.text)).toContain('aws_secret_access_key = [redacted]')
    expect(sent(part.text)).not.toMatch(/wJalr|EXAMPLEKEY/)
  })

  it('reads an attachment at any offset and length, and shows an image', async () => {
    writeFileSync(join(uploads, 'policy.json'), '{"Version":"2012-10-17","Statement":[]}')
    const part = await run(moreTool(deps), {
      evidence: 'attachment:policy.json',
      offset: 2,
      length: 7,
    })
    expect(sent(part.text)).toMatch(/^Version\n… 30 more bytes \(offset 9\)/)
    writeFileSync(join(uploads, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    const result = await moreTool(deps).execute(
      { evidence: 'attachment:shot.png' } as never,
      {
        conversationId: 'c1',
        callId: 'img-1',
        output: () => undefined,
        details: async () => undefined,
      } as never,
      { abortSignal: new AbortController().signal } as never,
    )
    const image = result.output?.find((item) => item.type === 'image') as
      | { mimeType: string; data: string }
      | undefined
    expect(image?.mimeType).toBe('image/png')
    expect(Buffer.from(image?.data ?? '', 'base64')).toHaveLength(7)
  })

  it('keeps every result, so a call can be read again by its evidence id', async () => {
    const listed = await call({ service: 's3', operation: 'ListBuckets' })
    const again = await run(moreTool(deps), { evidence: listed.details.evidenceId! })
    expect(sent(again.text)).toContain('Buckets')
  })
})

describe('probe', () => {
  it('sends a CORS preflight with the headers given, and never a credential', async () => {
    const preflight = await run(probeTool(deps), {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' },
    })
    expect(preflight.details.status).toBe('done')
    expect(sent(preflight.text)).toMatch(/"status": \d{3}/)
    const refused = await run(probeTool(deps), { headers: { Authorization: 'AWS4 x' } })
    expect(refused.details.status).toBe('failed')
    expect(sent(refused.text)).toMatch(/no credentials/)
  })

  it('reaches the account endpoint on this machine, and no other private address', async () => {
    const own = await run(probeTool(deps), { method: 'GET' })
    expect(own.details.status).toBe('done')
    expect(sent(own.text)).toMatch(/"body": /)
    const other = await run(probeTool(deps), { url: 'http://localhost:1/' })
    expect(other.details.status).toBe('failed')
    expect(sent(other.text)).toMatch(/not on the public internet/)
  })

  it('knows a public address from a private one', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ])
      expect(isPublicAddress(address)).toBe(false)
    for (const address of ['52.216.0.1', '13.32.0.1', '2600:9000::1'])
      expect(isPublicAddress(address)).toBe(true)
  })
})

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

  it('stops a body read at 1 MiB unless the agent asks for more', async () => {
    const first = await call({
      service: 's3',
      operation: 'GetObject',
      input: { Bucket: 'cors-open', Key: 'large.txt' },
    })
    const bodyOf = (result: { details: unknown }) =>
      (result.details as { view: { value: { Body: Record<string, unknown> } } }).view.value.Body
    expect(bodyOf(first)).toMatchObject({
      bytesRead: 1024 * 1024,
      more: true,
    })
    const whole = await call({
      service: 's3',
      operation: 'GetObject',
      input: { Bucket: 'cors-open', Key: 'large.txt' },
      max_bytes: 4 * 1024 * 1024,
    })
    const body = bodyOf(whole)
    expect(body.bytesRead).toBe(3 * 1024 * 1024)
    expect(body.more).toBeUndefined()
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
      checkCall(config, { service: 'sts', operation: 'GetDelegatedAccessToken' }),
    ).toThrow(/not a read/)
    for (const service of ['secretsmanager', 'ssm', 'lambda', 'ec2', 'ecr', 'dynamodb'])
      expect(() => checkCall(config, { service, operation: 'GetAnything' })).toThrow(
        /service must be one of/,
      )
    expect(() =>
      checkCall(config, { service: 'config', operation: 'BatchGetResourceConfig' }),
    ).not.toThrow()
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
    // A scope is authorization: nothing that sees beyond its buckets runs.
    for (const [service, operation, input] of [
      ['cloudtrail', 'LookupEvents', {}],
      ['iam', 'GetAccountAuthorizationDetails', {}],
      ['s3control', 'ListAccessPoints', {}],
      ['s3control', 'GetAccessPointPolicy', { Name: 'ap' }],
      ['s3control', 'ListStorageLensConfigurations', {}],
    ] as const)
      expect(() => checkCall(scoped, { service, operation, input })).toThrow(/scoped to logs/)
    for (const [service, operation, input] of [
      ['s3', 'ListBuckets', {}],
      ['s3', 'ListDirectoryBuckets', {}],
      ['sts', 'GetCallerIdentity', {}],
      ['s3control', 'GetPublicAccessBlock', {}],
      ['s3control', 'ListAccessPoints', { Bucket: 'logs' }],
    ] as const)
      expect(() => checkCall(scoped, { service, operation, input })).not.toThrow()
    // A member the operation does not model is refused: the SDK would drop it, so a
    // scope check on it would pass while the request reached every bucket.
    for (const operation of ['ListJobs', 'ListStorageLensConfigurations', 'GetAccessPointPolicy'])
      expect(() =>
        checkCall(scoped, {
          service: 's3control',
          operation,
          input: { Bucket: 'logs', Name: 'x' },
        }),
      ).toThrow(/has no input member/)
    expect(() =>
      checkCall(config, {
        service: 's3',
        operation: 'ListObjectsV2',
        input: { Bucket: 'b', Prefx: 'a' },
      }),
    ).toThrow(/no input member Prefx\. Its members: .*Prefix/)
    expect(() =>
      checkCall(config, { service: 'iam', operation: 'GetAccountSummary', input: { Bucket: 'b' } }),
    ).toThrow(/Its members: \(none\)/)
    // Reads that hand out credentials do not run.
    expect(() => checkCall(config, { service: 's3control', operation: 'GetDataAccess' })).toThrow(
      /not a read this app runs/,
    )
    expect(operationsOf('s3control')).not.toContain('GetDataAccess')
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

  it('keeps identifiers exactly and drops SDK metadata', () => {
    expect(
      shape({ $metadata: { httpStatusCode: 200 }, Owner: 'arn:aws:iam::123456789012:root' }),
    ).toEqual({ Owner: 'arn:aws:iam::123456789012:root' })
  })

  it('lets the agent tell one account from another and call with any key it was given', () => {
    const policy = shape({
      Statement: [
        { Principal: { AWS: 'arn:aws:iam::111122223333:root' } },
        { Principal: { AWS: 'arn:aws:iam::999988887777:role/vendor' } },
      ],
    })
    expect(JSON.stringify(policy)).toContain('111122223333')
    expect(JSON.stringify(policy)).toContain('999988887777')
    expect(
      shape({ Key: 'logs/202410241530/a&b <x>.csv', AccessKeyId: 'AKIAABCDEFGHIJKLMNOP' }),
    ).toEqual({
      Key: 'logs/202410241530/a&b <x>.csv',
      AccessKeyId: 'AKIAABCDEFGHIJKLMNOP',
    })
    expect(shape({ Credentials: { SecretAccessKey: 'wJalrXUtnFEMI' } })).toEqual({
      Credentials: { SecretAccessKey: '[redacted]' },
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
