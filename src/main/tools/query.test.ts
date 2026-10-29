import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ToolDetails } from '@shared/contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeS3 } from '../../../scripts/fake-s3.mjs'
import { objectsOf } from '../../../scripts/fake-s3-core.mjs'
import { AppDb } from '../db'
import { Providers } from '../providers'
import type { Vault } from '../security/vault'
import type { ToolDeps } from './policy'
import { queryTool, toTable } from './query'

const BUCKETS = {
  lake: {
    encryption: true,
    blocked: true,
    objects: { count: 2500, prefixes: ['raw/', 'curated/', 'tmp/'] },
  },
  hidden: { encryption: true, blocked: true, objects: { count: 10, prefixes: ['x/'] } },
}

let fake: { server: Server; endpoint: string }
let deps: ToolDeps
const dir = mkdtempSync(join(tmpdir(), 'sa-query-task-'))

async function run(args: Record<string, unknown>, signal?: AbortSignal) {
  const result = await queryTool(deps).execute(
    args as never,
    { conversationId: 'c', output: () => undefined, details: async () => undefined } as never,
    { abortSignal: signal } as never,
  )
  const text = result.output?.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? ''
  return { text, details: result.details as unknown as ToolDetails }
}

beforeAll(async () => {
  fake = await startFakeS3({ buckets: structuredClone(BUCKETS) })
  const db = await AppDb.open(
    await openNodeSqliteDatabase(join(mkdtempSync(join(tmpdir(), 'sa-query-')), 'db.sqlite')),
  )
  const vault = { seal: (v: string) => v, open: (v: string) => v } as unknown as Vault
  const providers = new Providers(db, vault)
  await providers.save({
    name: 'Q',
    endpoint: fake.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    auth: 'keys',
    accessKeyId: 'AKIAQ',
    secretAccessKey: 's',
    scope: { buckets: ['lake'] },
  })
  deps = {
    db,
    providers,
    taskDir: () => dir,
    datasetsDir: () => join(dir, 'datasets'),
    uploadsDir: () => join(dir, 'uploads'),
    lang: () => 'en',
  }
})

afterAll(() => {
  fake.server.close()
})

describe('read-only code mode', () => {
  it('pages through every object and returns the largest prefixes as a table and chart', async () => {
    const { details, text } = await run({
      title: 'Largest prefixes in lake',
      code: `
        const sizes = {}
        let token = null
        do {
          const page = await tools.call({
            service: 's3',
            operation: 'ListObjectsV2',
            input: { Bucket: 'lake', ContinuationToken: token ?? undefined },
          })
          for (const o of page.Contents ?? []) {
            const p = o.Key.split('/')[0] + '/'
            sizes[p] = (sizes[p] ?? 0) + o.Size
          }
          token = page.NextContinuationToken ?? null
        } while (token)
        return Object.entries(sizes).map(([prefix, bytes]) => ({ prefix, bytes })).sort((a, b) => b.bytes - a.bytes)
      `,
    })
    expect(details.status).toBe('done')
    const view = details.view
    if (view?.kind !== 'query') throw new Error('expected a query view')
    const expected = new Map<string, number>()
    for (const o of objectsOf(structuredClone(BUCKETS.lake))) {
      const p = `${o.key.split('/')[0]}/`
      expected.set(p, (expected.get(p) ?? 0) + o.size)
    }
    expect(view.rows.columns).toEqual(['prefix', 'bytes'])
    expect(new Map(view.rows.rows.map((r) => [r[0], r[1]]))).toEqual(expected)
    expect(view.chart?.labels).toHaveLength(3)
    expect(view.calls).toBe(3)
    expect(text).toContain('<untrusted-data source="storage">')
  })

  it('refuses a bucket outside the account scope from inside the script', async () => {
    const { details } = await run({
      title: 'x',
      code: `return (await tools.call({ service: 's3', operation: 'ListObjectsV2', input: { Bucket: 'hidden' } })).Contents`,
    })
    expect(details.status).toBe('failed')
    expect(details.note).toMatch(/outside this account's scope/)
  })

  it('has no network, filesystem or process in the sandbox', async () => {
    const { details } = await run({
      title: 'escape',
      code: 'return [{ fetch: typeof fetch, require: typeof require, process: typeof process, timer: typeof setTimeout }]',
    })
    if (details.view?.kind !== 'query') throw new Error('expected a query view')
    expect(details.view.rows.rows[0]).toEqual(['undefined', 'undefined', 'undefined', 'undefined'])
  })

  it('runs until the user stops it', async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 800)
    const { details } = await run({ title: 'loop', code: 'while (true) {}' }, stop.signal)
    expect(['stopped', 'failed']).toContain(details.status)
    expect(details.note ?? '').not.toMatch(/ran past/)
  })

  it('answers SQL over an attached log, and only reads', async () => {
    mkdirSync(join(dir, 'uploads'), { recursive: true })
    writeFileSync(
      join(dir, 'uploads', 'access.csv'),
      [
        'timestamp,method,path,status,bytes,latency_ms,remote_ip',
        '2026-02-01T10:00:00Z,GET,/a,200,10,5,203.0.113.9',
        '2026-02-01T10:00:01Z,GET,/b,200,20,7,203.0.113.9',
        '2026-02-01T10:00:02Z,PUT,/c,403,0,9,198.51.100.7',
      ].join('\n'),
    )
    const { details } = await run({
      title: 'by status',
      code: `
        await tools.dataset({ file: 'access.csv' })
        return await tools.sql({ file: 'access.csv', sql: 'SELECT status_code, count(*) AS n FROM rows GROUP BY status_code ORDER BY status_code' })
      `,
    })
    if (details.view?.kind !== 'query') throw new Error(`expected a query view: ${details.note}`)
    expect(details.view.rows.rows).toEqual([
      [200, 2],
      [403, 1],
    ])
    const write = await run({
      title: 'write',
      code: `await tools.dataset({ file: 'access.csv' }); return await tools.sql({ file: 'access.csv', sql: 'DELETE FROM rows' })`,
    })
    expect(write.details.status).toBe('failed')
  })

  it('turns any return value into a table, every row of it', () => {
    expect(toTable(42).table).toEqual({ columns: ['value'], rows: [[42]] })
    const many = toTable(Array.from({ length: 20_000 }, (_, i) => ({ i })))
    expect(many.table.rows).toHaveLength(20_000)
    expect(toTable([{ a: { nested: 'AKIAABCDEFGHIJKLMNOP' } }]).table.rows[0]?.[0]).toBe(
      '{"nested":"AKIA[redacted]"}',
    )
  })
})
