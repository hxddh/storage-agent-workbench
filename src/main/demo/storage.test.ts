import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ToolDetails } from '@shared/contract'
import { describe, expect, it } from 'vitest'
import { AppDb } from '../db'
import { Estate } from '../estate/estate'
import { Providers } from '../providers'
import type { Vault } from '../security/vault'
import { queryTool } from '../tools/query'
import { surveyTool } from '../tools/survey'

const call = async (tool: { execute: (...args: never[]) => Promise<unknown> }, args: unknown) => {
  const result = (await tool.execute(
    args as never,
    { conversationId: 'c', output: () => undefined, details: async () => undefined } as never,
    {} as never,
  )) as { details: ToolDetails }
  return result.details
}

describe('demo storage', () => {
  it('answers every tool in process, with something to find', async () => {
    const db = await AppDb.open(
      await openNodeSqliteDatabase(join(mkdtempSync(join(tmpdir(), 'sa-demo-')), 'db.sqlite')),
    )
    const vault = { seal: (v: string) => v, open: (v: string) => v } as unknown as Vault
    const providers = new Providers(db, vault)
    const account = await providers.addDemo()
    expect((await providers.addDemo()).id).toBe(account.id)
    const deps = {
      db,
      providers,
      estate: new Estate(db),
      datasetsDir: () => tmpdir(),
      uploadsDir: () => tmpdir(),
      lang: () => 'en',
    }

    const survey = await call(surveyTool(deps) as never, {})
    expect(survey.status).toBe('done')
    if (survey.view?.kind !== 'survey') throw new Error('expected a survey view')
    expect(survey.view.coverage.processed).toBe(6)
    expect(survey.view.coverage.unknown).toEqual(['acme-legacy-uploads'])
    const codes = new Set(survey.view.issues.map((issue) => `${issue.bucket}:${issue.code}`))
    expect(codes.has('acme-web-assets:public_exposure')).toBe(true)
    expect(codes.has('acme-partner-share:cors_all_origins')).toBe(true)
    expect(codes.has('acme-data-lake:noncurrent_never_expire')).toBe(true)
    // The demo is S3-compatible: no account-wide block, no CloudWatch.
    expect(survey.view.account?.pab).toBe('n/a')

    const query = await call(queryTool(deps) as never, {
      title: 'Prefixes in the data lake',
      code: `const r = await tools.list({ bucket: 'acme-data-lake', prefix: 'raw/', delimiter: '/' }); return r.prefixes.map((p) => ({ prefix: p }))`,
    })
    if (query.view?.kind !== 'query') throw new Error('expected a query view')
    expect(query.view.rows.rows.map((row) => row[0])).toEqual(['raw/clicks/', 'raw/events/'])
  })
})
