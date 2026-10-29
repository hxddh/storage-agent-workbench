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
      'agent_tools',
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

  it('migrates a v17 database in place and adds agent tools', async () => {
    const raw = await openNodeSqliteDatabase(
      join(mkdtempSync(join(tmpdir(), 'sa-v17-')), 'db.sqlite'),
    )
    await raw.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT);
      PRAGMA user_version = 17;
    `)
    const db = await AppDb.open(raw)
    expect(db.resetTasks).toBe(false)
    const tables = await raw.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_tools'",
    )
    expect(tables).toHaveLength(1)
    const version = await raw.get<{ user_version: number }>('PRAGMA user_version')
    expect(version?.user_version).toBe(HOST_SCHEMA_VERSION)
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

it('purges a delegated child conversation and its task rows', async () => {
  const db = await open()
  await db.raw.exec(`
      CREATE TABLE pi_conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT NOT NULL);
      CREATE TABLE pi_tasks (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, abort_requested INTEGER NOT NULL, background INTEGER NOT NULL, record TEXT NOT NULL);
      CREATE TABLE pi_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL);
      CREATE TABLE pi_submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE pi_documents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, family INTEGER NOT NULL, key_value TEXT NOT NULL, scope_kind TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, record TEXT NOT NULL);
      CREATE TABLE pi_document_revisions (document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (document_id, seq));
      INSERT INTO pi_conversations (id, owner_conversation_id, owner_task_id, record)
        VALUES (1, NULL, NULL, '{}'), (2, NULL, 10, '{}');
      INSERT INTO pi_tasks (id, conversation_id, kind, status, abort_requested, background, record)
        VALUES (10, 1, 'run', 'terminal', 0, 0, '{}'), (20, 2, 'run', 'terminal', 0, 0, '{}');
      INSERT INTO pi_entries (id, conversation_id, head, commit_seq, record)
        VALUES (100, 1, NULL, 1, '{}'), (200, 2, NULL, 2, '{}');
      INSERT INTO pi_submissions (id, conversation_id, request_id, status, record)
        VALUES (30, 1, 'a', 'done', '{}'), (31, 2, 'b', 'done', '{}');
      INSERT INTO pi_documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
        VALUES (40, 'x', 0, '"a"', 'conversation', 1, 1, NULL, '{}'),
               (41, 'x', 0, '"b"', 'task', 10, 1, NULL, '{}'),
               (42, 'x', 0, '"c"', 'conversation', 2, 1, NULL, '{}');
      INSERT INTO pi_document_revisions (document_id, seq, kind, version, content)
        VALUES (40, 1, 'base', 1, '{}'), (41, 1, 'base', 1, '{}'), (42, 1, 'base', 1, '{}');
      INSERT INTO task_meta (conversation_id, title, created_at, updated_at)
        VALUES ('1', 'parent', '', ''), ('2', 'child', '', '');
      INSERT INTO search_docs (conversation_id, entry_id, kind, text, at)
        VALUES ('1', 'a', 'user', 'parent', ''), ('2', 'b', 'user', 'child', '');
      INSERT INTO search_docs_fts (conversation_id, entry_id, kind, text, at)
        VALUES ('1', 'a', 'user', 'parent', ''), ('2', 'b', 'user', 'child', '');
      INSERT INTO agent_tools (id, scope, conversation_id, name, description, schema_json, code, created_at, updated_at)
        VALUES ('t1', 'task', '1', 'parent_tool', '', '{}', 'return 1', '', ''),
               ('t2', 'task', '2', 'child_tool', '', '{}', 'return 2', '', '');
    `)
  expect(await db.purgeTask('1')).toEqual(['1', '2'])
  for (const table of [
    'pi_conversations',
    'pi_tasks',
    'pi_entries',
    'pi_submissions',
    'pi_documents',
    'pi_document_revisions',
    'task_meta',
    'search_docs',
    'search_docs_fts',
    'agent_tools',
  ]) {
    const rows = await db.raw.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)
    expect(rows[0]?.n, table).toBe(0)
  }
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
