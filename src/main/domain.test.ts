/**
 * The domain end to end: the real AWS SDK against a fake S3 over HTTP, the real
 * tools through `agentTool()`, the estate in a real SQLite file. No model and
 * no window; this is what the brief's findings are made of.
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
import { Estate } from './estate/estate'
import { decide } from './estate/rules'
import { Providers } from './providers'
import { readBucket } from './s3/facts'
import type { Vault } from './security/vault'
import { configTool } from './tools/config'
import { estateTools } from './tools/estate'
import type { ToolDeps } from './tools/policy'
import { surveyTool } from './tools/survey'

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
  ) => ReturnType<ReturnType<typeof surveyTool>['execute']>
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
    estate: new Estate(db),
    datasetsDir: () => tmpdir(),
    uploadsDir: () => tmpdir(),
    lang: () => 'en',
  }
})

afterAll(() => {
  fake.server.close()
})

const read = (bucket: string) =>
  readBucket(client, bucket, {
    aspects: new Set(['security', 'lifecycle']),
    defaultRegion: 'us-east-1',
  })

describe('one reading of one bucket', () => {
  it('proves AWS exposure from the provider verdict', async () => {
    const decisions = decide(await read('aws-public'))
    expect(decisions.public_exposure?.verdict).toBe(true)
    expect(decisions.wildcard_principal?.verdict).toBe(true)
    expect(decisions.public_access_block_missing?.verdict).toBe(true)
  })

  it('proves exposure on a provider without policy status from the document', async () => {
    const facts = await read('compat-public')
    expect(facts.policyStatus.status).toBe('provider_unsupported')
    expect(facts.exposure.verdict).toBe(true)
    // No public access block API: that rule stays undecided, never clean.
    expect(decide(facts).public_access_block_missing).toBeUndefined()
  })

  it('does not call a condition-narrowed policy public', async () => {
    const decisions = decide(await read('compat-narrowed'))
    expect(decisions.public_exposure?.verdict).toBe(false)
    expect(decisions.wildcard_principal?.verdict).toBe(true)
    expect(decisions.wildcard_principal?.detail).toMatch(/condition/)
  })

  it('leaves exposure open when the ACL is denied', async () => {
    const facts = await read('acl-hidden')
    expect(facts.acl.status).toBe('access_denied')
    expect(decide(facts).public_exposure).toBeUndefined()
  })

  it('decides CORS and lifecycle rules from the configuration', async () => {
    expect(decide(await read('cors-open')).cors_all_origins?.verdict).toBe(true)
    expect(decide(await read('cors-open')).no_abort_mpu?.verdict).toBe(false)
    const versioned = decide(await read('versioned'))
    expect(versioned.no_abort_mpu?.verdict).toBe(true)
    expect(versioned.noncurrent_never_expire?.verdict).toBe(true)
  })
})

describe('tools over the estate', () => {
  it('surveys, remembers every bucket, and says what stayed open', async () => {
    const { text, details, isError } = await run(surveyTool(deps), {})
    expect(isError).toBe(false)
    expect(details.status).toBe('done')
    expect(text).toContain('<untrusted-data source="storage">')
    expect(text).toMatch(/Public: aws-public, compat-public/)
    expect(text).toMatch(/Undecided because a read was blind: .*acl-hidden \(public_exposure\)/)
    expect(await deps.db.countBuckets(providerId)).toBe(6)
    const view = details.view
    if (view?.kind !== 'survey') throw new Error('expected a survey view')
    expect(view.coverage.unknown).toEqual(['acl-hidden'])
    expect(view.observations?.length).toBeGreaterThan(20)
  })

  it('resolves a fixed bucket when it is re-read, and nothing else', async () => {
    await fetch(`${fake.endpoint}/__fake/fix?bucket=aws-public`, { method: 'POST' })
    const { details } = await run(surveyTool(deps), { buckets: ['aws-public'] })
    if (details.view?.kind !== 'survey') throw new Error('expected a survey view')
    expect(details.view.changed.resolved).toBe(3)
    const open = await deps.db.listIssues({ providerId, status: 'open', limit: 100 })
    expect(
      open.some((issue) => issue.bucket === 'aws-public' && issue.code === 'public_exposure'),
    ).toBe(false)
    expect(open.some((issue) => issue.bucket === 'compat-public')).toBe(true)
  })

  it('keeps an accepted Issue accepted while it is still observed', async () => {
    const issue = await deps.db.findIssue(providerId, 'cors-open', 'cors_all_origins')
    if (!issue) throw new Error('expected the CORS issue')
    await deps.db.setAccepted(issue.id, true)
    await run(configTool(deps), { bucket: 'cors-open', aspect: 'security' })
    expect((await deps.db.getIssue(issue.id))?.status).toBe('accepted')
  })

  it('a lifecycle review never clears a rule it proves present', async () => {
    const { details } = await run(configTool(deps), { bucket: 'versioned', aspect: 'lifecycle' })
    if (details.view?.kind !== 'config') throw new Error('expected a config view')
    expect(details.view.findings.map((finding) => finding.code)).toContain('no_abort_mpu')
    expect((await deps.db.findIssue(providerId, 'versioned', 'no_abort_mpu'))?.status).toBe('open')
  })

  it('ends the Issues of a bucket that disappeared from a complete listing', async () => {
    delete fake.buckets.versioned
    await run(surveyTool(deps), {})
    expect((await deps.db.findIssue(providerId, 'versioned', 'no_abort_mpu'))?.status).toBe(
      'resolved',
    )
    expect(await deps.db.countBuckets(providerId)).toBe(5)
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

  it('reports a stopped call as stopped, not failed', async () => {
    const controller = new AbortController()
    controller.abort()
    const { details } = await run(surveyTool(deps), {}, controller.signal)
    expect(details.status).toBe('stopped')
  })

  it('generates a fix only for an open Issue', async () => {
    const [, fix] = estateTools(deps)
    const ok = await run(fix as Executable, { bucket: 'compat-public', code: 'public_exposure' })
    expect(ok.details.status).toBe('done')
    const resolved = await run(fix as Executable, { bucket: 'aws-public', code: 'public_exposure' })
    expect(resolved.details.status).toBe('failed')
  })
})
