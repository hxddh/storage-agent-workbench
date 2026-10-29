import { randomUUID } from 'node:crypto'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { detectProviderKind } from './s3/capabilities'

export const HOST_SCHEMA_VERSION = 16

export interface ProviderRow {
  id: string
  name: string
  kind: string
  endpoint: string
  region: string
  force_path_style: number
  access_key_id: string | null
  secret_ref: string
  session_ref: string | null
  scope_json: string
  created_at: string
  auth: 'keys' | 'profile'
  profile: string | null
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
  kind TEXT NOT NULL DEFAULT 'aws',
  endpoint TEXT NOT NULL,
  region TEXT NOT NULL,
  force_path_style INTEGER NOT NULL DEFAULT 0,
  access_key_id TEXT,
  secret_ref TEXT NOT NULL,
  session_ref TEXT,
  scope_json TEXT NOT NULL DEFAULT '{"buckets":[]}',
  created_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS task_meta (
  conversation_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
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

CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_fts USING fts5(
  conversation_id UNINDEXED,
  entry_id UNINDEXED,
  kind UNINDEXED,
  text,
  at UNINDEXED,
  tokenize = 'trigram'
);
`

export class AppDb {
  /** Migration 15 cleared the task history; the shell clears `tasks/` on disk too. */
  resetTasks = false

  constructor(readonly raw: NodeSqliteDatabase) {}

  static async open(raw: NodeSqliteDatabase): Promise<AppDb> {
    await raw.exec('PRAGMA journal_mode = WAL')
    await raw.exec('PRAGMA foreign_keys = ON')
    await raw.exec(SCHEMA)
    const row = await raw.get<{ user_version: number }>('PRAGMA user_version')
    const version = row?.user_version ?? 0
    if (version < 3) {
      await raw.exec('DROP TABLE IF EXISTS watch')
      const columns = await raw.all<{ name: string }>('PRAGMA table_info(task_meta)')
      if (columns.some((column) => column.name === 'origin')) {
        await raw.exec('ALTER TABLE task_meta DROP COLUMN origin')
      }
    }
    if (version < 4) {
      // 18.0: account auth kinds, bucket region and disappearance, Issue evidence
      // and the user-owned accepted state.
      const add = async (table: string, column: string, ddl: string) => {
        const columns = await raw.all<{ name: string }>(`PRAGMA table_info(${table})`)
        // A table a later version dropped is not created again to be altered.
        if (columns.length && !columns.some((c) => c.name === column))
          await raw.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
      }
      await add('providers', 'auth', "auth TEXT NOT NULL DEFAULT 'keys'")
      await add('providers', 'profile', 'profile TEXT')
      await add('buckets', 'region', 'region TEXT')
      await add('buckets', 'gone_at', 'gone_at TEXT')
      await add('issues', 'detail', 'detail TEXT')
      await add('issues', 'accepted_at', 'accepted_at TEXT')
    }
    if (version < 5) {
      // 19.0: the account-wide posture (statuses and booleans, never the account id).
      const columns = await raw.all<{ name: string }>('PRAGMA table_info(providers)')
      if (!columns.some((c) => c.name === 'account_json'))
        await raw.exec('ALTER TABLE providers ADD COLUMN account_json TEXT')
      if (!columns.some((c) => c.name === 'account_at'))
        await raw.exec('ALTER TABLE providers ADD COLUMN account_at TEXT')
    }
    if (version < 6) {
      // 20.0: search rows gained the source entry id, and old tasks need the
      // current finding/verdict projection. Clearing rebuilds every task once.
      await raw.exec('DELETE FROM search_docs')
    }
    if (version < 7) {
      const columns = await raw.all<{ name: string }>('PRAGMA table_info(providers)')
      if (!columns.some((column) => column.name === 'kind'))
        await raw.exec("ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT 'aws'")
    }
    if (version < 8) {
      const columns = await raw.all<{ name: string }>('PRAGMA table_info(task_meta)')
      if (!columns.some((column) => column.name === 'pinned'))
        await raw.exec('ALTER TABLE task_meta ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    }
    if (version < 9) {
      await raw.exec(`CREATE TABLE IF NOT EXISTS posture_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        bucket TEXT NOT NULL,
        at TEXT NOT NULL,
        changes_json TEXT NOT NULL
      )`)
    }
    if (version < 10) {
      // 21.0: v7 added `kind` with an AWS default, which mislabelled every
      // existing R2/MinIO/Aliyun/other endpoint as AWS during an upgrade.
      // Endpoints are the only evidence those rows carry; infer once, without
      // touching real AWS endpoints (empty or *.amazonaws.com).
      const rows = await raw.all<{ id: string; endpoint: string; kind: string }>(
        'SELECT id, endpoint, kind FROM providers',
      )
      for (const row of rows) {
        if (row.kind !== 'aws' || !row.endpoint) continue
        const lower = row.endpoint.toLowerCase()
        const inferred = lower.includes('amazonaws.com') ? 'aws' : detectProviderKind(row.endpoint)
        if (inferred !== row.kind)
          await raw.run('UPDATE providers SET kind = ? WHERE id = ?', inferred, row.id)
      }
    }
    if (version < 13) {
      const columns = await raw.all<{ name: string }>('PRAGMA table_info(providers)')
      if (!columns.some((column) => column.name === 'schedule'))
        await raw.exec("ALTER TABLE providers ADD COLUMN schedule TEXT NOT NULL DEFAULT 'off'")
    }
    if (version < 12) {
      // 29.0: FTS5 trigram gives ranked substring search without changing the
      // durable search_docs rows. Rebuild once for existing tasks.
      await raw.exec('DELETE FROM search_docs_fts')
      const rows = await raw.all<{
        conversation_id: string
        entry_id: string
        kind: string
        text: string
        at: string
      }>('SELECT conversation_id, entry_id, kind, text, at FROM search_docs')
      for (const row of rows)
        await raw.run(
          'INSERT INTO search_docs_fts (conversation_id, entry_id, kind, text, at) VALUES (?, ?, ?, ?, ?)',
          row.conversation_id,
          row.entry_id,
          row.kind,
          row.text,
          row.at,
        )
    }
    if (version < 14) {
      // 34.0: one task may run with a model other than the Settings default.
      const columns = await raw.all<{ name: string }>('PRAGMA table_info(task_meta)')
      if (!columns.some((column) => column.name === 'model_json'))
        await raw.exec('ALTER TABLE task_meta ADD COLUMN model_json TEXT')
    }
    let resetTasks = false
    if (version >= 1 && version < 15) {
      // 35.0: one engine and one entry model. Tasks written by earlier
      // versions use entry kinds 35 does not read, so the task history starts
      // over. Accounts, remembered posture, Issues and their history, notes and
      // reading records stay; their links to old tasks become null.
      const pi = await raw.all<{ name: string; type: string }>(
        "SELECT name, type FROM sqlite_master WHERE name LIKE 'pi\\_%' ESCAPE '\\' AND type IN ('table', 'view')",
      )
      await raw.exec('PRAGMA foreign_keys = OFF')
      for (const item of pi)
        await raw.exec(`DROP ${item.type.toUpperCase()} IF EXISTS "${item.name}"`)
      await raw.exec('PRAGMA foreign_keys = ON')
      await raw.exec('DELETE FROM task_meta')
      await raw.exec('DELETE FROM search_docs')
      await raw.exec('DELETE FROM search_docs_fts')
      await raw.exec('DELETE FROM datasets')
      await raw.exec('DELETE FROM audit')
      resetTasks = true
    }
    if (version < 16) {
      // 36.0: the agent judges; the app keeps no verdicts of its own. The rule
      // engine's Issues and their events, the remembered posture, its diffs and
      // the reading records are dropped, with the provider columns only they
      // and the removed scheduled checks used. Accounts, notes and tasks stay.
      for (const table of ['issue_events', 'issues', 'readings', 'posture_changes', 'buckets'])
        await raw.exec(`DROP TABLE IF EXISTS ${table}`)
      const columns = await raw.all<{ name: string }>('PRAGMA table_info(providers)')
      for (const column of ['account_json', 'account_at', 'schedule'])
        if (columns.some((c) => c.name === column))
          await raw.exec(`ALTER TABLE providers DROP COLUMN ${column}`)
    }
    if (version < HOST_SCHEMA_VERSION) {
      await raw.exec(`PRAGMA user_version = ${HOST_SCHEMA_VERSION}`)
    }
    const db = new AppDb(raw)
    db.resetTasks = resetTasks
    return db
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
      `INSERT INTO providers (id, name, kind, endpoint, region, force_path_style, access_key_id,
         secret_ref, session_ref, scope_json, created_at, auth, profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, kind = excluded.kind, endpoint = excluded.endpoint, region = excluded.region,
         force_path_style = excluded.force_path_style, access_key_id = excluded.access_key_id,
         secret_ref = excluded.secret_ref, session_ref = excluded.session_ref,
         scope_json = excluded.scope_json, auth = excluded.auth, profile = excluded.profile`,
      row.id,
      row.name,
      row.kind,
      row.endpoint,
      row.region,
      row.force_path_style,
      row.access_key_id,
      row.secret_ref,
      row.session_ref,
      row.scope_json,
      row.created_at,
      row.auth,
      row.profile,
    )
  }

  async deleteProvider(id: string): Promise<void> {
    await this.raw.run('DELETE FROM providers WHERE id = ?', id)
    // Provider and bucket notes carry the provider id in `ref`. Remove them
    // with the account; an account-scoped memory cannot outlive its account.
    await this.raw.run('DELETE FROM notes WHERE ref = ? OR ref LIKE ?', id, `${id}/%`)
  }

  async deleteNote(id: string): Promise<void> {
    await this.raw.run('DELETE FROM notes WHERE id = ?', id)
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
    params.push(Math.max(1, Math.min(filter.limit ?? 20, 10_000)))
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

  // -- task metadata --------------------------------------------------------

  async upsertTaskMeta(row: {
    conversationId: string
    title: string
    createdAt?: string
  }): Promise<void> {
    const at = new Date().toISOString()
    await this.raw.run(
      `INSERT INTO task_meta (conversation_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET title = excluded.title,
         updated_at = excluded.updated_at`,
      row.conversationId,
      row.title,
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

  async setPinned(conversationId: string, pinned: boolean): Promise<void> {
    await this.raw.run(
      'UPDATE task_meta SET pinned = ? WHERE conversation_id = ?',
      pinned ? 1 : 0,
      conversationId,
    )
  }

  async listTaskMeta(): Promise<
    {
      conversation_id: string
      title: string
      created_at: string
      updated_at: string
      pinned: number
    }[]
  > {
    return this.raw.all(
      'SELECT conversation_id, title, created_at, updated_at, pinned FROM task_meta ORDER BY pinned DESC, updated_at DESC LIMIT 500',
    )
  }

  async getTaskMeta(conversationId: string): Promise<
    | {
        conversation_id: string
        title: string
        created_at: string
        updated_at: string
        pinned: number
        model_json: string | null
      }
    | undefined
  > {
    return this.raw.get(
      'SELECT conversation_id, title, created_at, updated_at, pinned, model_json FROM task_meta WHERE conversation_id = ?',
      conversationId,
    )
  }

  async setTaskModel(conversationId: string, modelJson: string | null): Promise<void> {
    await this.raw.run(
      'UPDATE task_meta SET model_json = ?, updated_at = ? WHERE conversation_id = ?',
      modelJson,
      new Date().toISOString(),
      conversationId,
    )
  }

  async deleteTaskMeta(conversationId: string): Promise<void> {
    await this.raw.run('DELETE FROM task_meta WHERE conversation_id = ?', conversationId)
  }

  /**
   * Delete everything a task owns: its pi conversation, entries, tasks,
   * submissions, documents and revisions, plus analysis rows and audit events.
   * The host schema is append-only, so this is the one place that removes rows.
   */
  async purgeTask(conversationId: string): Promise<void> {
    if (!/^\d+$/.test(conversationId)) return
    const id = Number(conversationId)
    await this.raw.transaction(async (tx) => {
      const tasks = await tx.all<{ id: number }>(
        'SELECT id FROM pi_tasks WHERE conversation_id = ?',
        id,
      )
      const taskIds = tasks.map((task) => task.id)
      const docs = await tx.all<{ id: number }>(
        taskIds.length
          ? `SELECT id FROM pi_documents WHERE (scope_kind = 'conversation' AND owner_id = ?)
             OR (scope_kind = 'task' AND owner_id IN (${taskIds.map(() => '?').join(',')}))`
          : `SELECT id FROM pi_documents WHERE scope_kind = 'conversation' AND owner_id = ?`,
        id,
        ...taskIds,
      )
      const docIds = docs.map((doc) => doc.id)
      if (docIds.length) {
        const marks = docIds.map(() => '?').join(',')
        await tx.run(`DELETE FROM pi_document_revisions WHERE document_id IN (${marks})`, ...docIds)
        await tx.run(`DELETE FROM pi_documents WHERE id IN (${marks})`, ...docIds)
      }
      await tx.run('DELETE FROM pi_tasks WHERE conversation_id = ?', id)
      await tx.run('DELETE FROM pi_submissions WHERE conversation_id = ?', id)
      await tx.run('DELETE FROM pi_entries WHERE conversation_id = ?', id)
      await tx.run('DELETE FROM pi_conversations WHERE id = ?', id)
      await tx.run('DELETE FROM datasets WHERE conversation_id = ?', id)
      await tx.run('DELETE FROM audit WHERE conversation_id = ?', id)
    })
  }

  // -- search ---------------------------------------------------------------

  async replaceSearchDocs(
    conversationId: string,
    docs: { entryId: string; kind: string; text: string; at: string }[],
  ): Promise<void> {
    await this.raw.transaction(async (tx) => {
      await tx.run('DELETE FROM search_docs WHERE conversation_id = ?', conversationId)
      await tx.run('DELETE FROM search_docs_fts WHERE conversation_id = ?', conversationId)
      for (const doc of docs) {
        const text = doc.text.slice(0, 20_000)
        await tx.run(
          'INSERT INTO search_docs (conversation_id, entry_id, kind, text, at) VALUES (?, ?, ?, ?, ?)',
          conversationId,
          doc.entryId,
          doc.kind,
          text,
          doc.at,
        )
        await tx.run(
          'INSERT INTO search_docs_fts (conversation_id, entry_id, kind, text, at) VALUES (?, ?, ?, ?, ?)',
          conversationId,
          doc.entryId,
          doc.kind,
          text,
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
    const cap = Math.max(1, Math.min(limit, 500))
    const trimmed = query.trim()
    // Trigram requires at least three characters. Short CJK queries keep the
    // substring path; longer queries are ranked by BM25 with kind weighting.
    if ([...trimmed].length < 3) {
      const escaped = trimmed.replace(/[%_\\]/g, (match) => `\\${match}`)
      return this.raw.all(
        `SELECT conversation_id, entry_id, kind, text, at FROM search_docs
         WHERE lower(text) LIKE lower(?) ESCAPE '\\' ORDER BY at DESC LIMIT ?`,
        `%${escaped}%`,
        cap,
      )
    }
    const match = `"${trimmed.replace(/"/g, '""')}"`
    return this.raw.all(
      `SELECT f.conversation_id, f.entry_id, f.kind, f.text, f.at
       FROM search_docs_fts f
       WHERE f.text MATCH ?
       ORDER BY bm25(search_docs_fts),
         CASE f.kind WHEN 'user' THEN 0 WHEN 'answer' THEN 1 WHEN 'finding' THEN 2 ELSE 3 END,
         f.at DESC
       LIMIT ?`,
      match,
      cap,
    )
  }

  async deleteSearchDocs(conversationId: string): Promise<void> {
    await this.raw.run('DELETE FROM search_docs WHERE conversation_id = ?', conversationId)
    await this.raw.run('DELETE FROM search_docs_fts WHERE conversation_id = ?', conversationId)
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
      'INSERT OR REPLACE INTO datasets (id, conversation_id, kind, path, rows, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
