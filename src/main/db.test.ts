import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { describe, expect, it } from 'vitest'
import { AppDb, HOST_SCHEMA_VERSION } from './db'

async function open(): Promise<AppDb> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-db-'))
  return AppDb.open(await openNodeSqliteDatabase(join(dir, 'test.sqlite')))
}

describe('search index', () => {
  it('finds a Chinese substring inside an answer', async () => {
    const db = await open()
    await db.replaceSearchDocs('c1', [
      { entryId: 'e1', kind: 'answer', text: 'web-assets 是公开的存储桶', at: '' },
    ])
    const hits = await db.searchDocs('存储')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.conversation_id).toBe('c1')
  })

  it('ranks a three-character CJK substring through the FTS index', async () => {
    const db = await open()
    await db.replaceSearchDocs('c1', [
      { entryId: 'e1', kind: 'answer', text: '存储桶策略公开', at: '' },
      { entryId: 'e2', kind: 'user', text: '如何检查存储桶', at: '' },
    ])
    const hits = await db.searchDocs('存储桶')
    expect(hits).toHaveLength(2)
    expect(hits[0]?.kind).toBe('user')
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

describe('schema', () => {
  it('creates the current schema on a new file', async () => {
    const raw = await openNodeSqliteDatabase(
      join(mkdtempSync(join(tmpdir(), 'sa-new-')), 'db.sqlite'),
    )
    const db = await AppDb.open(raw)
    expect(db.resetTasks).toBe(false)
    const version = await raw.get<{ user_version: number }>('PRAGMA user_version')
    expect(version?.user_version).toBe(HOST_SCHEMA_VERSION)
    const tables = await raw.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_docs_fts_%' ORDER BY name",
    )
    expect(tables.map((t) => t.name)).toEqual([
      'audit',
      'datasets',
      'notes',
      'providers',
      'search_docs',
      'search_docs_fts',
      'task_meta',
    ])
    // Opening it again changes nothing.
    expect((await AppDb.open(raw)).resetTasks).toBe(false)
  })

  it('starts over from a database of any other layout, pi tables included', async () => {
    const raw = await openNodeSqliteDatabase(
      join(mkdtempSync(join(tmpdir(), 'sa-old-')), 'db.sqlite'),
    )
    await raw.exec(`
      CREATE TABLE issues (id TEXT PRIMARY KEY);
      CREATE TABLE pi_entries (id INTEGER PRIMARY KEY);
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, kind TEXT);
      INSERT INTO providers VALUES ('p', 'Old', 'aws');
      PRAGMA user_version = 16;
    `)
    const db = await AppDb.open(raw)
    expect(db.resetTasks).toBe(true)
    const left = await raw.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name IN ('issues', 'pi_entries')",
    )
    expect(left).toEqual([])
    expect(await db.listProviders()).toEqual([])
    const columns = await raw.all<{ name: string }>('PRAGMA table_info(providers)')
    expect(columns.map((c) => c.name)).not.toContain('kind')
  })
})

describe('notes', () => {
  it('are plain text, newest first, and outlive the account they mention', async () => {
    const db = await open()
    await db.insertNote({ text: 'first' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await db.insertNote({ text: 'second' })
    await db.deleteProvider('p')
    expect((await db.listNotes()).map((note) => note.text)).toEqual(['second', 'first'])
  })
})
