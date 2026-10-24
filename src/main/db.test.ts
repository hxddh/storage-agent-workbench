import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { describe, expect, it } from 'vitest'
import { AppDb } from './db'

async function open(): Promise<AppDb> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-db-'))
  return AppDb.open(await openNodeSqliteDatabase(join(dir, 'test.sqlite')))
}

describe('search index', () => {
  it('finds a Chinese substring inside an answer', async () => {
    const db = await open()
    await db.replaceSearchDocs('c1', [
      { entryId: 'e1', kind: 'answer', text: 'demo-public 是公开的存储桶', at: '' },
    ])
    const hits = await db.searchDocs('存储')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.conversation_id).toBe('c1')
  })

  it('treats % and _ as text, not wildcards', async () => {
    const db = await open()
    await db.replaceSearchDocs('c1', [
      { entryId: 'e1', kind: 'answer', text: '100% complete', at: '' },
      { entryId: 'e2', kind: 'answer', text: '1000 complete', at: '' },
    ])
    const percent = await db.searchDocs('%')
    expect(percent).toHaveLength(1)
    expect(percent[0]?.text).toContain('%')
    const underscore = await db.searchDocs('_')
    expect(underscore).toHaveLength(0)
  })

  it('replaces a conversation index instead of appending', async () => {
    const db = await open()
    await db.replaceSearchDocs('c1', [{ entryId: 'e1', kind: 'user', text: 'first', at: '' }])
    await db.replaceSearchDocs('c1', [{ entryId: 'e2', kind: 'user', text: 'second', at: '' }])
    expect(await db.searchDocs('first')).toHaveLength(0)
    expect(await db.searchDocs('second')).toHaveLength(1)
    await db.deleteSearchDocs('c1')
    expect(await db.searchDocs('second')).toHaveLength(0)
  })
})
