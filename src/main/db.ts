import { randomUUID } from 'node:crypto'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
/**
 * The schema moves forward, never back and never cleared: a database at the
 * baseline (42.0.0's layout) or later is migrated step by step to the current
 * version. Only a layout older than the baseline, from before migrations
 * existed, is cleared. A database from a newer version is refused, so an
 * older build never destroys it.
 */
export const BASELINE_SCHEMA_VERSION = 22
export const HOST_SCHEMA_VERSION = 23

/** `MIGRATIONS[n]` takes a database from version n - 1 to n. */
const MIGRATIONS: Record<number, string> = {
  23: `
ALTER TABLE providers ADD COLUMN allow_changes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE providers ADD COLUMN write_auth TEXT;
ALTER TABLE providers ADD COLUMN write_profile TEXT;
ALTER TABLE providers ADD COLUMN write_access_key_id TEXT;
ALTER TABLE providers ADD COLUMN write_secret_ref TEXT;

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  cadence TEXT NOT NULL,
  budget_tokens INTEGER,
  conversation_id TEXT,
  task_id TEXT,
  created_by TEXT,
  next_at TEXT,
  last_at TEXT,
  last_outcome TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'change',
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT,
  status TEXT NOT NULL,
  result_json TEXT,
  rollback_of TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS changes_conversation ON changes(conversation_id);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
`,
}

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

export interface DatasetRecord {
  id: string
  /** `task` lives and dies with its conversation; `user` outlives it. */
  scope: 'task' | 'user'
  /** The conversation id for a task dataset, `user` for a kept one. */
  owner: string
  /** The name a script reads it by in `sql()`; unique within its owner. */
  name: string
  format: string
  /** Where the rows came from: a file name, an object ref, an `s3://` URL or `agent rows`. */
  source: string
  path: string
  rows: number
  bytes: number
  created_at: string
}

export interface ScheduleRecord {
  id: string
  name: string
  prompt: string
  /** `at <ISO>`, `every <n>m|<n>h`, `daily HH:MM` or `weekly <day> HH:MM`, local time. */
  cadence: string
  budget_tokens: number | null
  conversation_id: string | null
  task_id: string | null
  created_by: string | null
  next_at: string | null
  last_at: string | null
  last_outcome: string | null
  enabled: number
  created_at: string
}

export interface InboxRecord {
  id: string
  conversation_id: string | null
  title: string
  body: string
  created_at: string
  read_at: string | null
}

export interface AgentToolRecord {
  id: string
  scope: 'task' | 'user'
  conversation_id: string | null
  name: string
  description: string
  schema_json: string
  code: string
  created_at: string
  updated_at: string
}

/** The baseline layout (42.0.0); every later version is a migration on top. */
export const BASELINE_SCHEMA = `
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
  scope TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  rows INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS agent_tools (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  conversation_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, conversation_id, name)
);

CREATE INDEX IF NOT EXISTS datasets_owner ON datasets (owner);
CREATE INDEX IF NOT EXISTS agent_tools_name ON agent_tools (name);

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
    let version = tables.length ? (row?.user_version ?? 0) : 0
    if (version > HOST_SCHEMA_VERSION)
      throw new Error(
        `This data was written by a newer Storage Agent (schema ${version}); this build reads up to ${HOST_SCHEMA_VERSION}. Install the newer version; nothing was changed.`,
      )
    const reset = tables.length > 0 && version < BASELINE_SCHEMA_VERSION
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
    if (reset || version === 0) {
      // A new database starts at the baseline and takes every migration after it.
      await raw.exec(BASELINE_SCHEMA)
      version = BASELINE_SCHEMA_VERSION
      await raw.exec(`PRAGMA user_version = ${version}`)
    }
    for (let next = version + 1; next <= HOST_SCHEMA_VERSION; next++) {
      const step = MIGRATIONS[next]
      if (!step) throw new Error(`No migration to schema ${next}.`)
      await raw.exec('BEGIN')
      try {
        await raw.exec(step)
        await raw.exec(`PRAGMA user_version = ${next}`)
        await raw.exec('COMMIT')
      } catch (error) {
        await raw.exec('ROLLBACK')
        throw error
      }
    }
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

  // -- agent-authored tools -------------------------------------------------

  async listAgentTools(conversationId?: string): Promise<AgentToolRecord[]> {
    return this.raw.all<AgentToolRecord>(
      `SELECT * FROM agent_tools
       WHERE scope = 'user' OR (scope = 'task' AND conversation_id = ?)
       ORDER BY updated_at DESC`,
      conversationId ?? '',
    )
  }

  async getAgentTool(name: string, conversationId?: string): Promise<AgentToolRecord | undefined> {
    return this.raw.get<AgentToolRecord>(
      `SELECT * FROM agent_tools
       WHERE name = ? AND (scope = 'user' OR (scope = 'task' AND conversation_id = ?))
       ORDER BY scope = 'task' DESC LIMIT 1`,
      name,
      conversationId ?? '',
    )
  }

  // -- schedules ---------------------------------------------------------------

  async insertSchedule(row: ScheduleRecord): Promise<void> {
    await this.raw.run(
      `INSERT INTO schedules (id, name, prompt, cadence, budget_tokens, conversation_id, task_id, created_by, next_at, last_at, last_outcome, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.name,
      row.prompt,
      row.cadence,
      row.budget_tokens,
      row.conversation_id,
      row.task_id,
      row.created_by,
      row.next_at,
      row.last_at,
      row.last_outcome,
      row.enabled,
      row.created_at,
    )
  }

  async updateSchedule(id: string, patch: Partial<ScheduleRecord>): Promise<void> {
    const columns = new Set([
      'name',
      'prompt',
      'cadence',
      'budget_tokens',
      'conversation_id',
      'task_id',
      'next_at',
      'last_at',
      'last_outcome',
      'enabled',
    ])
    const keys = Object.keys(patch).filter((key) => columns.has(key))
    if (!keys.length) return
    await this.raw.run(
      `UPDATE schedules SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((key) => (patch as Record<string, unknown>)[key] as never),
      id,
    )
  }

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    return this.raw.get<ScheduleRecord>('SELECT * FROM schedules WHERE id = ?', id)
  }

  async scheduleByName(name: string): Promise<ScheduleRecord | undefined> {
    return this.raw.get<ScheduleRecord>('SELECT * FROM schedules WHERE name = ?', name)
  }

  async listSchedules(): Promise<ScheduleRecord[]> {
    return this.raw.all<ScheduleRecord>('SELECT * FROM schedules ORDER BY created_at')
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.raw.run('DELETE FROM schedules WHERE id = ?', id)
  }

  // -- inbox -------------------------------------------------------------------

  async addInbox(row: {
    conversationId: string | null
    title: string
    body: string
  }): Promise<InboxRecord> {
    const record: InboxRecord = {
      id: randomUUID(),
      conversation_id: row.conversationId,
      title: row.title,
      body: row.body,
      created_at: new Date().toISOString(),
      read_at: null,
    }
    await this.raw.run(
      'INSERT INTO inbox (id, conversation_id, title, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?)',
      record.id,
      record.conversation_id,
      record.title,
      record.body,
      record.created_at,
      null,
    )
    return record
  }

  async listInbox(limit = 100): Promise<InboxRecord[]> {
    return this.raw.all<InboxRecord>('SELECT * FROM inbox ORDER BY created_at DESC LIMIT ?', limit)
  }

  async markInboxRead(id?: string): Promise<void> {
    const at = new Date().toISOString()
    if (id)
      await this.raw.run('UPDATE inbox SET read_at = ? WHERE id = ? AND read_at IS NULL', at, id)
    else await this.raw.run('UPDATE inbox SET read_at = ? WHERE read_at IS NULL', at)
  }

  async upsertAgentTool(row: {
    scope: 'task' | 'user'
    conversationId: string | null
    name: string
    description: string
    schemaJson: string
    code: string
  }): Promise<AgentToolRecord> {
    const at = new Date().toISOString()
    const existing = await this.raw.get<AgentToolRecord>(
      `SELECT * FROM agent_tools WHERE scope = ? AND conversation_id IS ? AND name = ?`,
      row.scope,
      row.conversationId,
      row.name,
    )
    if (existing) {
      await this.raw.run(
        `UPDATE agent_tools SET description = ?, schema_json = ?, code = ?, updated_at = ?
         WHERE id = ?`,
        row.description,
        row.schemaJson,
        row.code,
        at,
        existing.id,
      )
      return {
        ...existing,
        description: row.description,
        schema_json: row.schemaJson,
        code: row.code,
        updated_at: at,
      }
    }
    const record: AgentToolRecord = {
      id: randomUUID(),
      scope: row.scope,
      conversation_id: row.conversationId,
      name: row.name,
      description: row.description,
      schema_json: row.schemaJson,
      code: row.code,
      created_at: at,
      updated_at: at,
    }
    await this.raw.run(
      `INSERT INTO agent_tools (id, scope, conversation_id, name, description, schema_json, code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.scope,
      record.conversation_id,
      record.name,
      record.description,
      record.schema_json,
      record.code,
      record.created_at,
      record.updated_at,
    )
    return record
  }

  async deleteAgentTool(id: string): Promise<void> {
    await this.raw.run('DELETE FROM agent_tools WHERE id = ?', id)
  }

  async deleteAgentToolsForTask(conversationId: string): Promise<void> {
    await this.raw.run(
      "DELETE FROM agent_tools WHERE scope = 'task' AND conversation_id = ?",
      conversationId,
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
   * A delegated child conversation is owned by one of this task's pi tasks, so
   * it is removed too. Returns every conversation id whose task folder must go.
   * The host schema is append-only, so this is the one place that removes rows.
   */
  async purgeTask(conversationId: string): Promise<string[]> {
    if (!/^\d+$/.test(conversationId)) return []
    const id = Number(conversationId)
    const removed: string[] = []
    await this.raw.transaction(async (tx) => {
      const purge = async (current: number): Promise<void> => {
        const key = String(current)
        if (removed.includes(key)) return
        removed.push(key)
        const tasks = await tx.all<{ id: number }>(
          'SELECT id FROM pi_tasks WHERE conversation_id = ?',
          current,
        )
        const taskIds = tasks.map((task) => task.id)
        const children = taskIds.length
          ? await tx.all<{ id: number }>(
              `SELECT id FROM pi_conversations WHERE owner_task_id IN (${taskIds.map(() => '?').join(',')})`,
              ...taskIds,
            )
          : []
        for (const child of children) await purge(child.id)
        const docs = await tx.all<{ id: number }>(
          taskIds.length
            ? `SELECT id FROM pi_documents WHERE (scope_kind = 'conversation' AND owner_id = ?)
               OR (scope_kind = 'task' AND owner_id IN (${taskIds.map(() => '?').join(',')}))`
            : `SELECT id FROM pi_documents WHERE scope_kind = 'conversation' AND owner_id = ?`,
          current,
          ...taskIds,
        )
        const docIds = docs.map((doc) => doc.id)
        if (docIds.length) {
          const marks = docIds.map(() => '?').join(',')
          await tx.run(
            `DELETE FROM pi_document_revisions WHERE document_id IN (${marks})`,
            ...docIds,
          )
          await tx.run(`DELETE FROM pi_documents WHERE id IN (${marks})`, ...docIds)
        }
        await tx.run('DELETE FROM pi_tasks WHERE conversation_id = ?', current)
        await tx.run('DELETE FROM pi_submissions WHERE conversation_id = ?', current)
        await tx.run('DELETE FROM pi_entries WHERE conversation_id = ?', current)
        await tx.run('DELETE FROM pi_conversations WHERE id = ?', current)
        await tx.run('DELETE FROM datasets WHERE owner = ?', current)
        await tx.run('DELETE FROM audit WHERE conversation_id = ?', current)
        await tx.run('DELETE FROM search_docs WHERE conversation_id = ?', key)
        await tx.run('DELETE FROM search_docs_fts WHERE conversation_id = ?', key)
        await tx.run('DELETE FROM task_meta WHERE conversation_id = ?', key)
        await tx.run("DELETE FROM agent_tools WHERE scope = 'task' AND conversation_id = ?", key)
      }
      await purge(id)
    })
    return removed
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
        const text = doc.text
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

  /** Add or replace the rows of one run, without rewriting the whole task. */
  async upsertSearchDocs(
    conversationId: string,
    docs: { entryId: string; kind: string; text: string; at: string }[],
  ): Promise<void> {
    if (!docs.length) return
    await this.raw.transaction(async (tx) => {
      for (const doc of docs) {
        await tx.run(
          'INSERT OR REPLACE INTO search_docs (conversation_id, entry_id, kind, text, at) VALUES (?, ?, ?, ?, ?)',
          conversationId,
          doc.entryId,
          doc.kind,
          doc.text,
          doc.at,
        )
        await tx.run(
          'DELETE FROM search_docs_fts WHERE conversation_id = ? AND entry_id = ?',
          conversationId,
          doc.entryId,
        )
        await tx.run(
          'INSERT INTO search_docs_fts (conversation_id, entry_id, kind, text, at) VALUES (?, ?, ?, ?, ?)',
          conversationId,
          doc.entryId,
          doc.kind,
          doc.text,
          doc.at,
        )
      }
    })
  }

  /** Matching messages and answers, best first; every match unless a limit is given. */
  async searchDocs(
    query: string,
    limit?: number,
  ): Promise<
    { conversation_id: string; entry_id: string; kind: string; text: string; at: string }[]
  > {
    const cap = limit && limit > 0 ? limit : -1
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

  /** A task's messages and answers, in order. */
  async taskDocs(
    conversationId: string,
  ): Promise<{ entry_id: string; kind: string; text: string; at: string }[]> {
    return this.raw.all(
      'SELECT entry_id, kind, text, at FROM search_docs WHERE conversation_id = ? ORDER BY at',
      conversationId,
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

  /**
   * The task a conversation belongs to: itself, or for a delegated child the
   * conversation of the task that owns it, followed up to the top. A child
   * reads and writes the same task folder, datasets and task memory as the
   * task it works for.
   */
  async rootConversation(conversationId: string): Promise<string> {
    let current = conversationId
    const seen = new Set<string>()
    try {
      while (!seen.has(current)) {
        seen.add(current)
        if (!/^\d+$/.test(current)) return current
        const row = await this.raw.get<{ owner_task_id: number | null }>(
          'SELECT owner_task_id FROM pi_conversations WHERE id = ?',
          Number(current),
        )
        if (!row?.owner_task_id) return current
        const owner = await this.raw.get<{ conversation_id: number }>(
          'SELECT conversation_id FROM pi_tasks WHERE id = ?',
          row.owner_task_id,
        )
        if (!owner) return current
        current = String(owner.conversation_id)
      }
    } catch {
      // pi's tables are not there (a bare host database): the conversation is its own task.
    }
    return current
  }

  // -- datasets -------------------------------------------------------------

  /** Record a dataset; one of the same name for the same owner is replaced. */
  async upsertDataset(row: Omit<DatasetRecord, 'created_at'>): Promise<DatasetRecord> {
    const record: DatasetRecord = { ...row, created_at: new Date().toISOString() }
    await this.raw.run(
      'DELETE FROM datasets WHERE owner = ? AND name = ?',
      record.owner,
      record.name,
    )
    await this.raw.run(
      `INSERT INTO datasets (id, scope, owner, name, format, source, path, rows, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.scope,
      record.owner,
      record.name,
      record.format,
      record.source,
      record.path,
      record.rows,
      record.bytes,
      record.created_at,
    )
    return record
  }

  /** The record at one exact owner and name, for replacing its file. */
  async datasetByOwner(owner: string, name: string): Promise<DatasetRecord | undefined> {
    return this.raw.get<DatasetRecord>(
      'SELECT * FROM datasets WHERE owner = ? AND name = ?',
      owner,
      name,
    )
  }

  /** A task dataset shadows a kept one of the same name. */
  async datasetByName(conversationId: string, name: string): Promise<DatasetRecord | undefined> {
    return this.raw.get<DatasetRecord>(
      `SELECT * FROM datasets WHERE owner IN (?, 'user') AND name = ?
       ORDER BY CASE WHEN owner = ? THEN 0 ELSE 1 END LIMIT 1`,
      conversationId,
      name,
      conversationId,
    )
  }

  /** This task's datasets and the ones kept for the user, task first. */
  async listDatasets(conversationId: string): Promise<DatasetRecord[]> {
    return this.raw.all<DatasetRecord>(
      `SELECT * FROM datasets WHERE owner IN (?, 'user')
       ORDER BY CASE WHEN owner = ? THEN 0 ELSE 1 END, created_at`,
      conversationId,
      conversationId,
    )
  }

  /** The datasets the agent kept for the user across tasks. */
  async listUserDatasets(): Promise<DatasetRecord[]> {
    return this.raw.all<DatasetRecord>(
      "SELECT * FROM datasets WHERE scope = 'user' ORDER BY created_at",
    )
  }

  async userDatasetBytes(): Promise<number> {
    const row = await this.raw.get<{ bytes: number | null }>(
      "SELECT SUM(bytes) AS bytes FROM datasets WHERE scope = 'user'",
    )
    return row?.bytes ?? 0
  }

  async getDataset(id: string): Promise<DatasetRecord | undefined> {
    return this.raw.get<DatasetRecord>('SELECT * FROM datasets WHERE id = ?', id)
  }

  async deleteDataset(id: string): Promise<void> {
    await this.raw.run('DELETE FROM datasets WHERE id = ?', id)
  }
}
