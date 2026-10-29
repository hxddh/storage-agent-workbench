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
  it('migrates a 17.x database to the head without losing rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-mig-'))
    const raw = await openNodeSqliteDatabase(join(dir, 'old.sqlite'))
    await raw.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL,
        region TEXT NOT NULL, force_path_style INTEGER NOT NULL DEFAULT 0, access_key_id TEXT,
        secret_ref TEXT NOT NULL, session_ref TEXT, scope_json TEXT NOT NULL DEFAULT '{"buckets":[]}',
        created_at TEXT NOT NULL);
      INSERT INTO providers VALUES ('p', 'Old', '', 'us-east-1', 0, 'AKIA', 'ref', NULL, '{"buckets":[]}', '2026');
      CREATE TABLE issues (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, bucket TEXT NOT NULL,
        code TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, opened_at TEXT NOT NULL,
        resolved_at TEXT, last_seen_at TEXT NOT NULL, recurred INTEGER NOT NULL DEFAULT 0,
        UNIQUE (provider_id, bucket, code));
      INSERT INTO issues VALUES ('i', 'p', 'b', 'public_exposure', 'high', 'open', '2026', NULL, '2026', 0);
      PRAGMA user_version = 3;
    `)
    const db = await AppDb.open(raw)
    const version = await raw.get<{ user_version: number }>('PRAGMA user_version')
    expect(version?.user_version).toBe(HOST_SCHEMA_VERSION)
    expect((await db.getProvider('p'))?.auth).toBe('keys')
    const issues = await raw.all("SELECT name FROM sqlite_master WHERE name = 'issues'")
    expect(issues).toEqual([])
  })

  it('starts the task history over at 35 but keeps accounts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-mig35-'))
    const raw = await openNodeSqliteDatabase(join(dir, 'v34.sqlite'))
    const first = await AppDb.open(raw)
    await raw.exec(`
      CREATE TABLE pi_conversations (id INTEGER PRIMARY KEY);
      CREATE TABLE pi_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER REFERENCES pi_conversations(id));
      INSERT INTO pi_conversations VALUES (1);
      INSERT INTO pi_entries VALUES (1, 1);
      INSERT INTO providers (id, name, endpoint, region, force_path_style, secret_ref, scope_json, created_at)
        VALUES ('p', 'Kept', '', 'us-east-1', 0, 'ref', '{"buckets":[]}', '2026');
      PRAGMA user_version = 14;
    `)
    await first.upsertTaskMeta({ conversationId: '1', title: 'Old task' })
    await first.replaceSearchDocs('1', [{ entryId: 'e', kind: 'answer', text: 'old', at: '' }])
    const db = await AppDb.open(raw)
    expect(db.resetTasks).toBe(true)
    expect(await db.listTaskMeta()).toEqual([])
    expect(await db.searchDocs('old')).toEqual([])
    const tables = await raw.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name LIKE 'pi\\_%' ESCAPE '\\'",
    )
    expect(tables).toEqual([])
    expect((await db.getProvider('p'))?.name).toBe('Kept')
    // Opening the head again changes nothing.
    expect((await AppDb.open(raw)).resetTasks).toBe(false)
  })

  it('drops the 35.x rule memory and keeps accounts, notes and tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-mig36-'))
    const raw = await openNodeSqliteDatabase(join(dir, 'v35.sqlite'))
    await raw.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL,
        region TEXT NOT NULL, force_path_style INTEGER NOT NULL DEFAULT 0, access_key_id TEXT,
        secret_ref TEXT NOT NULL, session_ref TEXT, scope_json TEXT NOT NULL DEFAULT '{"buckets":[]}',
        created_at TEXT NOT NULL, schedule TEXT NOT NULL DEFAULT 'off', account_json TEXT, account_at TEXT);
      INSERT INTO providers (id, name, endpoint, region, secret_ref, created_at, schedule)
        VALUES ('p', 'Kept', '', 'us-east-1', 'ref', '2026', 'daily');
      CREATE TABLE readings (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, complete INTEGER);
      CREATE TABLE issues (id TEXT PRIMARY KEY);
      CREATE TABLE issue_events (id TEXT PRIMARY KEY);
      CREATE TABLE posture_changes (id TEXT PRIMARY KEY);
      CREATE TABLE buckets (provider_id TEXT, name TEXT);
      INSERT INTO readings VALUES ('r1', 'p', 1);
      PRAGMA user_version = 15;
    `)
    const db = await AppDb.open(raw)
    await db.upsertTaskMeta({ conversationId: '7', title: 'Kept task' })
    expect(db.resetTasks).toBe(false)
    const gone = await raw.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('readings', 'issues', 'issue_events', 'posture_changes', 'buckets')",
    )
    expect(gone).toEqual([])
    const columns = await raw.all<{ name: string }>('PRAGMA table_info(providers)')
    expect(columns.map((column) => column.name)).not.toContain('schedule')
    expect(columns.map((column) => column.name)).not.toContain('account_json')
    expect((await db.getProvider('p'))?.name).toBe('Kept')
    expect((await db.listTaskMeta()).map((row) => row.title)).toContain('Kept task')
    const version = await raw.get<{ user_version: number }>('PRAGMA user_version')
    expect(version?.user_version).toBe(HOST_SCHEMA_VERSION)
  })

  it('infers the kind of a provider added before the kind column existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-mig-kind-'))
    const raw = await openNodeSqliteDatabase(join(dir, 'old.sqlite'))
    await raw.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL,
        region TEXT NOT NULL, force_path_style INTEGER NOT NULL DEFAULT 0, access_key_id TEXT,
        secret_ref TEXT NOT NULL, session_ref TEXT, scope_json TEXT NOT NULL DEFAULT '{"buckets":[]}',
        created_at TEXT NOT NULL);
      INSERT INTO providers VALUES ('r2', 'R2', 'https://account.r2.cloudflarestorage.com', 'auto', 1, 'AKIA', 'ref', NULL, '{"buckets":[]}', '2026');
      PRAGMA user_version = 6;
    `)
    const db = await AppDb.open(raw)
    expect((await db.getProvider('r2'))?.kind).toBe('r2')
  })
})

describe('provider deletion', () => {
  it('removes provider and bucket notes but keeps estate memory', async () => {
    const db = await open()
    await db.insertNote({ scope: 'provider', ref: 'p', text: 'account note', author: 'agent' })
    await db.insertNote({ scope: 'bucket', ref: 'p/logs', text: 'bucket note', author: 'agent' })
    await db.insertNote({ scope: 'estate', ref: null, text: 'estate note', author: 'agent' })
    await db.deleteProvider('p')
    expect((await db.listNotes()).map((note) => note.text)).toEqual(['estate note'])
  })
})
