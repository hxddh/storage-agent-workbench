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
    expect(version?.user_version).toBe(11)
    expect((await db.getProvider('p'))?.auth).toBe('keys')
    expect((await db.getIssue('i'))?.detail).toBeNull()
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

describe('issue lifecycle', () => {
  const observe = (db: AppDb, observed: boolean, detail?: string) =>
    db.upsertIssue({
      providerId: 'p',
      bucket: 'b',
      code: 'cors_all_origins',
      severity: 'medium',
      observed,
      detail,
      conversationId: null,
    })

  it('opens, keeps its evidence, accepts, and only a clean reading ends acceptance', async () => {
    const db = await open()
    const opened = await observe(db, true, "A CORS rule allows origin '*'")
    expect(opened.event).toBe('opened')
    expect(opened.issue?.detail).toBe("A CORS rule allows origin '*'")
    await db.setAccepted(opened.issue!.id, true)
    expect((await observe(db, true)).issue?.status).toBe('accepted')
    expect((await observe(db, false)).event).toBe('resolved')
    const back = await observe(db, true)
    expect(back.event).toBe('recurred')
    expect(back.issue?.status).toBe('open')
  })

  it('never lets acceptance reopen a resolved Issue', async () => {
    const db = await open()
    const opened = await observe(db, true)
    await observe(db, false)
    expect((await db.setAccepted(opened.issue!.id, true))?.status).toBe('resolved')
  })

  it('hides a bucket that is gone and brings it back when it is seen again', async () => {
    const db = await open()
    await db.upsertBucket('p', 'b', {})
    await db.markGone('p', ['b'])
    expect(await db.countBuckets('p')).toBe(0)
    await db.upsertBucket('p', 'b', {})
    expect(await db.countBuckets('p')).toBe(1)
  })

  it('keeps complete and partial readings apart and returns the latest complete one', async () => {
    const db = await open()
    await db.insertReading({
      conversationId: 'c1',
      providerId: 'p',
      at: '2026-01-01T00:00:00.000Z',
      trigger: 'check',
      complete: true,
      visible: 3,
      processed: 3,
      pending: 0,
      denied: 0,
      unknown: 0,
      truncated: 0,
      openHigh: 1,
      openTotal: 2,
    })
    await db.insertReading({
      conversationId: 'c2',
      providerId: 'p',
      at: '2026-01-02T00:00:00.000Z',
      trigger: 'task',
      complete: false,
      visible: 3,
      processed: 2,
      pending: 1,
      denied: 0,
      unknown: 0,
      truncated: 0,
      openHigh: 2,
      openTotal: 3,
    })
    expect((await db.listReadings({ providerId: 'p' })).map((row) => row.complete)).toEqual([0, 1])
    expect((await db.latestCompleteReading('p'))?.at).toBe('2026-01-01T00:00:00.000Z')
    expect(await db.listReadings({ providerId: 'p', complete: true })).toHaveLength(1)
  })

  it('reads Issue events with the Issue they belong to, and filters them', async () => {
    const db = await open()
    const opened = await observe(db, true, 'The policy is public')
    const issue = opened.issue!
    await db.insertEvent(issue.id, 'c1', 'accepted', '2020-01-01T00:00:00.000Z', null)
    const events = await db.listIssueEvents({
      providerId: 'p',
      bucket: 'b',
      code: 'cors_all_origins',
    })
    expect(events.map((event) => event.kind)).toEqual(['opened', 'accepted'])
    expect(events[0]).toMatchObject({
      bucket: 'b',
      code: 'cors_all_origins',
      provider_id: 'p',
      detail: 'The policy is public',
    })
    expect(await db.listIssueEvents({ bucket: 'other' })).toHaveLength(0)
    expect(await db.listIssueEvents({ since: '2021-01-01T00:00:00.000Z' })).toHaveLength(1)
  })
})
