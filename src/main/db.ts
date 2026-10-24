import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { Severity } from '@shared/contract'

export const HOST_SCHEMA_VERSION = 2

export interface ProviderRow {
  id: string
  name: string
  endpoint: string
  region: string
  force_path_style: number
  access_key_id: string | null
  secret_ref: string
  session_ref: string | null
  scope_json: string
  created_at: string
}

export interface BucketRow {
  provider_id: string
  name: string
  posture_json: string | null
  posture_at: string | null
  first_seen: string
  last_seen: string
}

export interface IssueRecord {
  id: string
  provider_id: string
  bucket: string
  code: string
  severity: Severity
  status: 'open' | 'resolved'
  opened_at: string
  resolved_at: string | null
  last_seen_at: string
  recurred: number
}

export interface NoteRecord {
  id: string
  scope: 'estate' | 'provider' | 'bucket'
  ref: string | null
  text: string
  author: 'agent' | 'user'
  created_at: string
}

export interface DatasetRecord {
  id: string
  conversation_id: string
  kind: string
  path: string
  rows: number
  bytes: number
  created_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  region TEXT NOT NULL,
  force_path_style INTEGER NOT NULL DEFAULT 0,
  access_key_id TEXT,
  secret_ref TEXT NOT NULL,
  session_ref TEXT,
  scope_json TEXT NOT NULL DEFAULT '{"buckets":[]}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS buckets (
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  posture_json TEXT,
  posture_at TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (provider_id, name)
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  last_seen_at TEXT NOT NULL,
  recurred INTEGER NOT NULL DEFAULT 0,
  UNIQUE (provider_id, bucket, code)
);

CREATE TABLE IF NOT EXISTS issue_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  conversation_id TEXT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  ref TEXT,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  tool TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch (
  provider_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_hours INTEGER NOT NULL DEFAULT 24,
  last_run_at TEXT
);

CREATE TABLE IF NOT EXISTS task_meta (
  conversation_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  rows INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS issues_open ON issues (provider_id, status, severity);
CREATE INDEX IF NOT EXISTS issue_events_issue ON issue_events (issue_id, at);
CREATE INDEX IF NOT EXISTS notes_scope ON notes (scope, ref, created_at);
CREATE INDEX IF NOT EXISTS datasets_conversation ON datasets (conversation_id);

CREATE TABLE IF NOT EXISTS search_docs (
  conversation_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, entry_id)
);

CREATE INDEX IF NOT EXISTS search_docs_conversation ON search_docs (conversation_id);
`

export class AppDb {
  constructor(readonly raw: NodeSqliteDatabase) {}

  static async open(raw: NodeSqliteDatabase): Promise<AppDb> {
    await raw.exec('PRAGMA journal_mode = WAL')
    await raw.exec('PRAGMA foreign_keys = ON')
    await raw.exec(SCHEMA)
    const row = await raw.get<{ user_version: number }>('PRAGMA user_version')
    if ((row?.user_version ?? 0) < HOST_SCHEMA_VERSION) {
      await raw.exec(`PRAGMA user_version = ${HOST_SCHEMA_VERSION}`)
    }
    return new AppDb(raw)
  }

  // -- providers ------------------------------------------------------------

  async listProviders(): Promise<ProviderRow[]> {
    return this.raw.all<ProviderRow>('SELECT * FROM providers ORDER BY created_at')
  }

  async getProvider(id: string): Promise<ProviderRow | undefined> {
    return this.raw.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id)
  }

  async upsertProvider(row: ProviderRow): Promise<void> {
    await this.raw.run(
      `INSERT INTO providers (id, name, endpoint, region, force_path_style, access_key_id,
         secret_ref, session_ref, scope_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, endpoint = excluded.endpoint, region = excluded.region,
         force_path_style = excluded.force_path_style, access_key_id = excluded.access_key_id,
         secret_ref = excluded.secret_ref, session_ref = excluded.session_ref,
         scope_json = excluded.scope_json`,
      row.id,
      row.name,
      row.endpoint,
      row.region,
      row.force_path_style,
      row.access_key_id,
      row.secret_ref,
      row.session_ref,
      row.scope_json,
      row.created_at,
    )
    await this.raw.run(
      'INSERT INTO watch (provider_id, enabled, interval_hours) VALUES (?, 0, 24) ON CONFLICT DO NOTHING',
      row.id,
    )
  }

  async deleteProvider(id: string): Promise<void> {
    await this.raw.run('DELETE FROM providers WHERE id = ?', id)
    await this.raw.run('DELETE FROM buckets WHERE provider_id = ?', id)
    await this.raw.run('DELETE FROM issues WHERE provider_id = ?', id)
    await this.raw.run('DELETE FROM watch WHERE provider_id = ?', id)
  }

  // -- buckets --------------------------------------------------------------

  async upsertBucket(
    providerId: string,
    name: string,
    posture: Record<string, unknown>,
  ): Promise<void> {
    const at = new Date().toISOString()
    await this.raw.run(
      `INSERT INTO buckets (provider_id, name, posture_json, posture_at, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, name) DO UPDATE SET
         posture_json = excluded.posture_json, posture_at = excluded.posture_at,
         last_seen = excluded.last_seen`,
      providerId,
      name,
      JSON.stringify(posture),
      at,
      at,
      at,
    )
  }

  async listBuckets(providerId: string): Promise<BucketRow[]> {
    return this.raw.all<BucketRow>(
      'SELECT * FROM buckets WHERE provider_id = ? ORDER BY name',
      providerId,
    )
  }

  async countBuckets(providerId: string): Promise<number> {
    const row = await this.raw.get<{ n: number }>(
      'SELECT count(*) AS n FROM buckets WHERE provider_id = ?',
      providerId,
    )
    return row?.n ?? 0
  }

  // -- issues ---------------------------------------------------------------

  async listIssues(
    filter: { providerId?: string; status?: 'open' | 'resolved'; limit?: number } = {},
  ): Promise<IssueRecord[]> {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.providerId) {
      where.push('provider_id = ?')
      params.push(filter.providerId)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    params.push(Math.max(1, Math.min(filter.limit ?? 50, 200)))
    return this.raw.all<IssueRecord>(
      `SELECT * FROM issues ${clause}
       ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                last_seen_at DESC, bucket, code
       LIMIT ?`,
      ...params,
    )
  }

  async getIssue(id: string): Promise<IssueRecord | undefined> {
    return this.raw.get<IssueRecord>('SELECT * FROM issues WHERE id = ?', id)
  }

  async findIssue(
    providerId: string,
    bucket: string,
    code: string,
  ): Promise<IssueRecord | undefined> {
    return this.raw.get<IssueRecord>(
      'SELECT * FROM issues WHERE provider_id = ? AND bucket = ? AND code = ?',
      providerId,
      bucket,
      code,
    )
  }

  async countNotes(author?: 'agent' | 'user'): Promise<number> {
    const row = author
      ? await this.raw.get<{ n: number }>(
          'SELECT count(*) AS n FROM notes WHERE author = ?',
          author,
        )
      : await this.raw.get<{ n: number }>('SELECT count(*) AS n FROM notes')
    return row?.n ?? 0
  }

  async upsertIssue(input: {
    providerId: string
    bucket: string
    code: string
    severity: Severity
    observed: boolean
    conversationId: string | null
  }): Promise<{ issue: IssueRecord; event: 'opened' | 'resolved' | 'recurred' | null }> {
    const at = new Date().toISOString()
    const existing = await this.raw.get<IssueRecord>(
      'SELECT * FROM issues WHERE provider_id = ? AND bucket = ? AND code = ?',
      input.providerId,
      input.bucket,
      input.code,
    )
    if (input.observed) {
      if (!existing) {
        const id = randomUUID()
        await this.raw.run(
          `INSERT INTO issues (id, provider_id, bucket, code, severity, status, opened_at,
             resolved_at, last_seen_at, recurred)
           VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, ?, 0)`,
          id,
          input.providerId,
          input.bucket,
          input.code,
          input.severity,
          at,
          at,
        )
        await this.insertEvent(id, input.conversationId, 'opened', at, null)
        return { issue: (await this.getIssue(id))!, event: 'opened' }
      }
      if (existing.status === 'resolved') {
        await this.raw.run(
          `UPDATE issues SET status = 'open', severity = ?, resolved_at = NULL,
             last_seen_at = ?, recurred = recurred + 1 WHERE id = ?`,
          input.severity,
          at,
          existing.id,
        )
        await this.insertEvent(existing.id, input.conversationId, 'recurred', at, null)
        return { issue: (await this.getIssue(existing.id))!, event: 'recurred' }
      }
      await this.raw.run(
        'UPDATE issues SET severity = ?, last_seen_at = ? WHERE id = ?',
        input.severity,
        at,
        existing.id,
      )
      return { issue: (await this.getIssue(existing.id))!, event: null }
    }
    if (existing && existing.status === 'open') {
      await this.raw.run(
        "UPDATE issues SET status = 'resolved', resolved_at = ?, last_seen_at = ? WHERE id = ?",
        at,
        at,
        existing.id,
      )
      await this.insertEvent(existing.id, input.conversationId, 'resolved', at, null)
      return { issue: (await this.getIssue(existing.id))!, event: 'resolved' }
    }
    return { issue: existing ?? (null as unknown as IssueRecord), event: null }
  }

  async insertEvent(
    issueId: string,
    conversationId: string | null,
    kind: string,
    at: string,
    detail: unknown,
  ): Promise<void> {
    await this.raw.run(
      'INSERT INTO issue_events (id, issue_id, conversation_id, kind, at, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(),
      issueId,
      conversationId,
      kind,
      at,
      detail === null ? null : JSON.stringify(detail),
    )
  }

  async issuesForConversation(conversationId: string): Promise<IssueRecord[]> {
    const rows = await this.raw.all<{ issue_id: string }>(
      'SELECT DISTINCT issue_id FROM issue_events WHERE conversation_id = ?',
      conversationId,
    )
    const out: IssueRecord[] = []
    for (const row of rows) {
      const issue = await this.getIssue(row.issue_id)
      if (issue) out.push(issue)
    }
    return out
  }

  // -- notes ----------------------------------------------------------------

  async insertNote(note: Omit<NoteRecord, 'id' | 'created_at'>): Promise<NoteRecord> {
    const record: NoteRecord = {
      ...note,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    }
    await this.raw.run(
      'INSERT INTO notes (id, scope, ref, text, author, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      record.id,
      record.scope,
      record.ref,
      record.text,
      record.author,
      record.created_at,
    )
    return record
  }

  async listNotes(
    filter: { scope?: string; ref?: string; limit?: number } = {},
  ): Promise<NoteRecord[]> {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.scope) {
      where.push('scope = ?')
      params.push(filter.scope)
    }
    if (filter.ref) {
      where.push('ref = ?')
      params.push(filter.ref)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    params.push(Math.max(1, Math.min(filter.limit ?? 20, 100)))
    return this.raw.all<NoteRecord>(
      `SELECT * FROM notes ${clause} ORDER BY created_at DESC LIMIT ?`,
      ...params,
    )
  }

  async searchNotes(query: string, limit = 10): Promise<NoteRecord[]> {
    const q = `%${query.replace(/[%_]/g, '')}%`
    return this.raw.all<NoteRecord>(
      'SELECT * FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?',
      q,
      Math.max(1, Math.min(limit, 50)),
    )
  }

  // -- audit ----------------------------------------------------------------

  async audit(row: {
    conversationId: string | null
    tool: string
    target: string | null
    outcome: string
  }): Promise<void> {
    await this.raw.run(
      'INSERT INTO audit (id, conversation_id, tool, target, outcome, at) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(),
      row.conversationId,
      row.tool,
      row.target,
      row.outcome,
      new Date().toISOString(),
    )
  }

  // -- watch ----------------------------------------------------------------

  async watchFor(
    providerId: string,
  ): Promise<{ enabled: boolean; intervalHours: number; lastRunAt: string | null }> {
    const row = await this.raw.get<{
      enabled: number
      interval_hours: number
      last_run_at: string | null
    }>('SELECT * FROM watch WHERE provider_id = ?', providerId)
    return {
      enabled: row?.enabled === 1,
      intervalHours: row?.interval_hours ?? 24,
      lastRunAt: row?.last_run_at ?? null,
    }
  }

  async setWatch(
    providerId: string,
    patch: { enabled?: boolean; intervalHours?: number },
  ): Promise<void> {
    const current = await this.watchFor(providerId)
    await this.raw.run(
      `INSERT INTO watch (provider_id, enabled, interval_hours) VALUES (?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET enabled = excluded.enabled,
         interval_hours = excluded.interval_hours`,
      providerId,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      Math.max(1, Math.min(patch.intervalHours ?? current.intervalHours, 24 * 30)),
    )
  }

  async markWatchRun(providerId: string): Promise<void> {
    await this.raw.run(
      'UPDATE watch SET last_run_at = ? WHERE provider_id = ?',
      new Date().toISOString(),
      providerId,
    )
  }

  async enabledWatches(): Promise<
    { provider_id: string; interval_hours: number; last_run_at: string | null }[]
  > {
    return this.raw.all<{
      provider_id: string
      interval_hours: number
      last_run_at: string | null
    }>('SELECT provider_id, interval_hours, last_run_at FROM watch WHERE enabled = 1')
  }

  // -- task metadata --------------------------------------------------------

  async upsertTaskMeta(row: {
    conversationId: string
    title: string
    origin: 'user' | 'watch'
    createdAt?: string
  }): Promise<void> {
    const at = new Date().toISOString()
    await this.raw.run(
      `INSERT INTO task_meta (conversation_id, title, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET title = excluded.title,
         updated_at = excluded.updated_at`,
      row.conversationId,
      row.title,
      row.origin,
      row.createdAt ?? at,
      at,
    )
  }

  async touchTask(conversationId: string): Promise<void> {
    await this.raw.run(
      'UPDATE task_meta SET updated_at = ? WHERE conversation_id = ?',
      new Date().toISOString(),
      conversationId,
    )
  }

  async listTaskMeta(): Promise<
    {
      conversation_id: string
      title: string
      origin: 'user' | 'watch'
      created_at: string
      updated_at: string
    }[]
  > {
    return this.raw.all(
      'SELECT conversation_id, title, origin, created_at, updated_at FROM task_meta ORDER BY updated_at DESC LIMIT 500',
    )
  }

  async getTaskMeta(conversationId: string): Promise<
    | {
        conversation_id: string
        title: string
        origin: 'user' | 'watch'
        created_at: string
        updated_at: string
      }
    | undefined
  > {
    return this.raw.get(
      'SELECT conversation_id, title, origin, created_at, updated_at FROM task_meta WHERE conversation_id = ?',
      conversationId,
    )
  }

  async deleteTaskMeta(conversationId: string): Promise<void> {
    await this.raw.run('DELETE FROM task_meta WHERE conversation_id = ?', conversationId)
  }

  // -- search ---------------------------------------------------------------

  async replaceSearchDocs(
    conversationId: string,
    docs: { entryId: string; kind: string; text: string; at: string }[],
  ): Promise<void> {
    await this.raw.transaction(async (tx) => {
      await tx.run('DELETE FROM search_docs WHERE conversation_id = ?', conversationId)
      for (const doc of docs) {
        await tx.run(
          'INSERT INTO search_docs (conversation_id, entry_id, kind, text, at) VALUES (?, ?, ?, ?, ?)',
          conversationId,
          doc.entryId,
          doc.kind,
          doc.text.slice(0, 20_000),
          doc.at,
        )
      }
    })
  }

  async searchDocs(
    query: string,
    limit = 200,
  ): Promise<
    { conversation_id: string; entry_id: string; kind: string; text: string; at: string }[]
  > {
    const escaped = query.replace(/[%_\\]/g, (match) => `\\${match}`)
    const pattern = `%${escaped}%`
    return this.raw.all(
      `SELECT conversation_id, entry_id, kind, text, at FROM search_docs
       WHERE lower(text) LIKE lower(?) ESCAPE '\\'
       ORDER BY at DESC LIMIT ?`,
      pattern,
      Math.max(1, Math.min(limit, 500)),
    )
  }

  async deleteSearchDocs(conversationId: string): Promise<void> {
    await this.raw.run('DELETE FROM search_docs WHERE conversation_id = ?', conversationId)
  }

  async conversationsWithoutSearch(): Promise<string[]> {
    const rows = await this.raw.all<{ conversation_id: string }>(
      `SELECT m.conversation_id FROM task_meta m
       LEFT JOIN search_docs d ON d.conversation_id = m.conversation_id
       GROUP BY m.conversation_id HAVING count(d.entry_id) = 0
       ORDER BY m.updated_at DESC LIMIT 100`,
    )
    return rows.map((row) => row.conversation_id)
  }

  // -- datasets -------------------------------------------------------------

  async insertDataset(row: Omit<DatasetRecord, 'created_at'>): Promise<DatasetRecord> {
    const record: DatasetRecord = { ...row, created_at: new Date().toISOString() }
    await this.raw.run(
      'INSERT INTO datasets (id, conversation_id, kind, path, rows, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      record.id,
      record.conversation_id,
      record.kind,
      record.path,
      record.rows,
      record.bytes,
      record.created_at,
    )
    return record
  }

  async listDatasets(conversationId: string): Promise<DatasetRecord[]> {
    return this.raw.all<DatasetRecord>(
      'SELECT * FROM datasets WHERE conversation_id = ? ORDER BY created_at',
      conversationId,
    )
  }

  async getDataset(id: string): Promise<DatasetRecord | undefined> {
    return this.raw.get<DatasetRecord>('SELECT * FROM datasets WHERE id = ?', id)
  }

  async deleteDataset(id: string): Promise<void> {
    await this.raw.run('DELETE FROM datasets WHERE id = ?', id)
  }
}

export function databasePath(userData: string): string {
  return join(userData, 'storage-agent.db')
}
