import { randomUUID } from 'node:crypto'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
/**
 * The schema this version writes. A database at any other version is cleared
 * and created again: the app carries nothing from an earlier layout.
 */
export const HOST_SCHEMA_VERSION = 17

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
  auth: 'keys' | 'profile'
  profile: string | null
}

export interface NoteRecord {
  id: string
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
  created_at TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT 'keys',
  profile TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
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
  pinned INTEGER NOT NULL DEFAULT 0,
  model_json TEXT
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

CREATE INDEX IF NOT EXISTS notes_created ON notes (created_at);
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
  /** The database was cleared on open; the shell clears `tasks/` on disk too. */
  resetTasks = false

  constructor(readonly raw: NodeSqliteDatabase) {}

  static async open(raw: NodeSqliteDatabase): Promise<AppDb> {
    await raw.exec('PRAGMA journal_mode = WAL')
    const row = await raw.get<{ user_version: number }>('PRAGMA user_version')
    const tables = await raw.all<{ name: string; type: string }>(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    const reset = tables.length > 0 && (row?.user_version ?? 0) !== HOST_SCHEMA_VERSION
    if (reset) {
      await raw.exec('PRAGMA foreign_keys = OFF')
      // Shadow tables of an FTS table go with it; drop the virtual tables first.
      for (const item of tables.filter((t) => t.name.endsWith('_fts')))
        await raw.exec(`DROP TABLE IF EXISTS "${item.name}"`)
      const left = await raw.all<{ name: string; type: string }>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      )
      for (const item of left)
        await raw.exec(`DROP ${item.type.toUpperCase()} IF EXISTS "${item.name}"`)
    }
    await raw.exec('PRAGMA foreign_keys = ON')
    await raw.exec(SCHEMA)
    await raw.exec(`PRAGMA user_version = ${HOST_SCHEMA_VERSION}`)
    const db = new AppDb(raw)
    db.resetTasks = reset
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
      `INSERT INTO providers (id, name, endpoint, region, force_path_style, access_key_id,
         secret_ref, session_ref, scope_json, created_at, auth, profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, endpoint = excluded.endpoint, region = excluded.region,
         force_path_style = excluded.force_path_style, access_key_id = excluded.access_key_id,
         secret_ref = excluded.secret_ref, session_ref = excluded.session_ref,
         scope_json = excluded.scope_json, auth = excluded.auth, profile = excluded.profile`,
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
      row.auth,
      row.profile,
    )
  }

  async deleteProvider(id: string): Promise<void> {
    await this.raw.run('DELETE FROM providers WHERE id = ?', id)
  }

  async deleteNote(id: string): Promise<void> {
    await this.raw.run('DELETE FROM notes WHERE id = ?', id)
  }

  // -- notes ----------------------------------------------------------------

  async insertNote(note: Omit<NoteRecord, 'id' | 'created_at'>): Promise<NoteRecord> {
    const record: NoteRecord = {
      ...note,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    }
    await this.raw.run(
      'INSERT INTO notes (id, text, author, created_at) VALUES (?, ?, ?, ?)',
      record.id,
      record.text,
      record.author,
      record.created_at,
    )
    return record
  }

  /** Every note, newest first. */
  async listNotes(): Promise<NoteRecord[]> {
    return this.raw.all<NoteRecord>('SELECT * FROM notes ORDER BY created_at DESC')
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
         CASE f.kind WHEN 'user' THEN 0 WHEN 'answer' THEN 1 ELSE 2 END,
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
