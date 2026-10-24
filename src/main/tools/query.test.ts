import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ToolDetails } from '@shared/contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeS3 } from '../../../scripts/fake-s3.mjs'
import { AppDb } from '../db'
import { objectsOf } from '../demo/fake-s3-core.mjs'
import { Estate } from '../estate/estate'
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

async function run(args: Record<string, unknown>, timeoutMs?: number) {
  const result = await queryTool(deps, timeoutMs).execute(
    args as never,
    { conversationId: 'c', output: () => undefined, details: async () => undefined } as never,
    {} as never,
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
    estate: new Estate(db),
    datasetsDir: () => tmpdir(),
    uploadsDir: () => tmpdir(),
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
          const page = await tools.list({ bucket: 'lake', token })
          for (const o of page.items) {
            const p = o.key.split('/')[0] + '/'
            sizes[p] = (sizes[p] ?? 0) + o.size
          }
          token = page.next
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
    expect(view.listed).toBe(2500)
    expect(view.calls).toBe(3)
    expect(text).toContain('<untrusted-data source="storage">')
  })

  it('refuses a bucket outside the account scope from inside the script', async () => {
    const { details } = await run({
      title: 'x',
      code: `return (await tools.list({ bucket: 'hidden' })).items`,
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

  it('stops a script that never ends', async () => {
    const { details } = await run({ title: 'loop', code: 'while (true) {}' }, 1500)
    expect(details.status).toBe('failed')
    expect(details.note).toMatch(/ran past 2 s|ran past 1 s/)
  })

  it('turns odd return values into a bounded table', () => {
    expect(toTable(42).table).toEqual({ columns: ['value'], rows: [[42]], truncated: false })
    const many = toTable(Array.from({ length: 600 }, (_, i) => ({ i })))
    expect(many.table.rows).toHaveLength(500)
    expect(many.table.truncated).toBe(true)
    expect(toTable([{ a: { nested: 'AKIAABCDEFGHIJKLMNOP' } }]).table.rows[0]?.[0]).toBe(
      '{"nested":"AKIA[redacted]"}',
    )
  })
})
