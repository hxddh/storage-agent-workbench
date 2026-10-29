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
import { bucketTools } from './tools/browse'
import { configTool } from './tools/config'
import { estateTools } from './tools/estate'
import type { ToolDeps } from './tools/policy'
import { probeTool } from './tools/probe'
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
    // A first survey resolves nothing, so it carries no resolutions; the open Issues are in the view.
    expect(view.observations).toEqual([])
    expect(view.issueTotal).toBeGreaterThan(5)
    expect(view.issues.length).toBe(view.issueTotal)
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

  it('returns Issue, posture and reading history, but omits account-wide readings from a bucket filter', async () => {
    await deps.db.insertReading({
      conversationId: 'c1',
      providerId,
      at: '2026-01-03T00:00:00.000Z',
      trigger: 'check',
      visible: 6,
      processed: 6,
      pending: 0,
      denied: 0,
      unknown: 0,
      truncated: 0,
      openHigh: 1,
      openTotal: 2,
    })
    await deps.db.insertChanges(providerId, 'cors-open', [
      {
        bucket: 'cors-open',
        field: 'CORS',
        before: 'no wildcard',
        after: 'wildcard',
        at: '2026-01-02T00:00:00.000Z',
      },
    ])
    const estate = estateTools(deps)[0] as Executable
    const { text, details } = await run(estate, { bucket: 'cors-open', history: true })
    expect(details.status).toBe('done')
    if (details.view?.kind !== 'estate') throw new Error('expected an estate view')
    expect(details.view.history?.columns).toEqual(['When', 'Event', 'Bucket', 'Evidence'])
    expect(details.view.history?.rows.some((row) => row[1] === 'accepted')).toBe(true)
    expect(details.view.history?.rows.some((row) => row[1] === 'changed')).toBe(true)
    expect(details.view.history?.rows.some((row) => row[1] === 'checked')).toBe(false)
    expect(text).toContain('History (newest first')
    const unfiltered = await run(estate, { history: true })
    if (unfiltered.details.view?.kind !== 'estate') throw new Error('expected an estate view')
    expect(unfiltered.details.view.history?.rows.some((row) => row[1] === 'checked')).toBe(true)
    const empty = await run(estate, {
      bucket: 'cors-open',
      history: true,
      since: '2099-01-01T00:00:00.000Z',
    })
    if (empty.details.view?.kind !== 'estate') throw new Error('expected an estate view')
    expect(empty.details.view.history?.rows).toHaveLength(0)
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

  it('shows the policy and ACL grants behind access', async () => {
    const { details } = await run(configTool(deps), {
      bucket: 'compat-public',
      aspect: 'access',
    })
    expect(details.status).toBe('done')
    if (details.view?.kind !== 'config') throw new Error('expected a config view')
    expect(details.view.access?.some((item) => item.source === 'policy')).toBe(true)
    expect(details.view.access?.some((item) => item.public)).toBe(true)
  })

  it('shares one access session per run, and records what the rules did on the call', async () => {
    const sessions = new Map()
    const withSessions = { ...deps, accessSessions: sessions }
    await run(configTool(withSessions), { bucket: 'compat-public', aspect: 'access' })
    expect(sessions.has('c1')).toBe(true)
    const db = await AppDb.open(
      await openNodeSqliteDatabase(join(mkdtempSync(join(tmpdir(), 'sa-assess-')), 'db.sqlite')),
    )
    const fresh = { ...deps, db, providers: new Providers(db, vault), estate: new Estate(db) }
    await fresh.providers.save({
      name: 'Fresh',
      endpoint: fake.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      auth: 'keys',
      accessKeyId: 'AKIAFAKEFAKEFAKEFAKE',
      secretAccessKey: 'secret',
      scope: { buckets: [] },
    })
    const { details } = await run(surveyTool(fresh), {})
    if (details.view?.kind !== 'survey') throw new Error('expected a survey')
    expect(details.view.changed.opened).toBeGreaterThan(0)
  })

  it('generates a batch when no bucket or code narrows it', async () => {
    await run(surveyTool(deps), {})
    const [, change] = estateTools(deps)
    const { details } = await run(change as Executable, {})
    expect(details.status).toBe('done')
    if (details.view?.kind !== 'change') throw new Error('expected a change view')
    expect(details.view.formats.length).toBeGreaterThan(0)
    const plan = details.view.plan
    if (!plan) throw new Error('expected a change plan')
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.steps.every((step) => step.codes.length > 0 && step.formats.length > 0)).toBe(true)
    const lifecycle = plan.steps.filter((step) => step.id.startsWith('lifecycle:'))
    expect(new Set(lifecycle.map((step) => step.bucket)).size).toBe(lifecycle.length)
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

  it('plans a change the agent names for a bucket even when no Issue is open', async () => {
    const [, change] = estateTools(deps)
    const { details } = await run(change as Executable, {
      bucket: Object.keys(fake.buckets)[0]!,
      code: 'no_abort_mpu',
    })
    if (details.view?.kind !== 'change' || !details.view.plan)
      throw new Error(`expected a change plan; got ${details.status}: ${details.note ?? ''}`)
    expect(details.view.plan.steps[0]?.codes).toContain('no_abort_mpu')
  })

  it('omits Terraform rather than dropping existing lifecycle rules from a merged step', async () => {
    fake.buckets.versioned = structuredClone(BUCKETS.versioned!)
    await run(surveyTool(deps), {})
    const [, change] = estateTools(deps)
    const { details } = await run(change as Executable, { bucket: 'versioned' })
    if (details.view?.kind !== 'change' || !details.view.plan)
      throw new Error(`expected a change plan; got ${details.status}: ${details.note ?? ''}`)
    const merged = details.view.plan.steps.find((step) => step.id.startsWith('lifecycle:'))
    if (!merged) throw new Error('expected a merged lifecycle step')
    expect(merged.formats.map((format) => format.label)).not.toContain('Terraform')
    expect(merged.notes.join(' ')).toContain('Terraform is omitted')
  })

  it('reports a stopped call as stopped, not failed', async () => {
    const controller = new AbortController()
    controller.abort()
    const { details } = await run(surveyTool(deps), {}, controller.signal)
    expect(details.status).toBe('stopped')
  })

  it('narrows to open Issues unless the agent names both the bucket and the change', async () => {
    const [, change] = estateTools(deps)
    const ok = await run(change as Executable, { bucket: 'compat-public', code: 'public_exposure' })
    expect(ok.details.status).toBe('done')
    const named = await run(change as Executable, {
      bucket: 'aws-public',
      code: 'public_exposure',
    })
    expect(named.details.status).toBe('done')
    const none = await run(change as Executable, { bucket: 'never-read' })
    expect(none.details.status).toBe('failed')
  })
})
