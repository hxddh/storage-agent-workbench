import { randomUUID } from 'node:crypto'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { Severity } from '@shared/contract'
import { detectProviderKind } from './s3/capabilities'

export const HOST_SCHEMA_VERSION = 15

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
  account_json?: string | null
  account_at?: string | null
  schedule?: string
}

export interface BucketRow {
  provider_id: string
  name: string
  posture_json: string | null
  posture_at: string | null
  first_seen: string
  last_seen: string
  region: string | null
  gone_at: string | null
}

export interface IssueRecord {
  id: string
  provider_id: string
  bucket: string
  code: string
  severity: Severity
  status: IssueStatus
  opened_at: string
  resolved_at: string | null
  last_seen_at: string
  recurred: number
  detail: string | null
  accepted_at: string | null
}

export type IssueStatus = 'open' | 'resolved' | 'accepted'

export type IssueEvent = 'opened' | 'resolved' | 'recurred' | 'gone' | 'accepted' | 'reopened'

/** One life-cycle event joined to the Issue it belongs to, for estate history. */
export interface IssueEventRecord {
  id: string
  issue_id: string
  conversation_id: string | null
  kind: IssueEvent
  at: string
  detail: string | null
  provider_id: string
  bucket: string
  code: string
  severity: Severity
  status: IssueStatus
  last_seen_at: string
}

export type ReadingTrigger = 'check' | 'task' | 'reverify'

/** A settled reading of an account, with its coverage and current open risk. */
export interface ReadingRecord {
  id: string
  conversation_id: string | null
  provider_id: string
  at: string
  trigger: ReadingTrigger
  complete: number
  visible: number
  processed: number
  pending: number
  denied: number
  unknown: number
  truncated: number
  open_high: number
  open_total: number
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
  created_at TEXT NOT NULL,
  schedule TEXT NOT NULL DEFAULT 'off'
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

CREATE TABLE IF NOT EXISTS task_meta (
  conversation_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posture_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  at TEXT NOT NULL,
  changes_json TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS readings (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  provider_id TEXT NOT NULL,
  at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL DEFAULT 0,
  unknown INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  open_high INTEGER NOT NULL DEFAULT 0,
  open_total INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS issues_open ON issues (provider_id, status, severity);
CREATE INDEX IF NOT EXISTS readings_provider_at ON readings (provider_id, complete, at);
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
        if (!columns.some((c) => c.name === column))
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
      await raw.exec('UPDATE issue_events SET conversation_id = NULL')
      await raw.exec('UPDATE readings SET conversation_id = NULL')
      resetTasks = true
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
         secret_ref, session_ref, scope_json, created_at, auth, profile, schedule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, kind = excluded.kind, endpoint = excluded.endpoint, region = excluded.region,
         force_path_style = excluded.force_path_style, access_key_id = excluded.access_key_id,
         secret_ref = excluded.secret_ref, session_ref = excluded.session_ref,
         scope_json = excluded.scope_json, auth = excluded.auth, profile = excluded.profile,
         schedule = excluded.schedule`,
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
      row.schedule ?? 'off',
    )
  }

  async setAccountPosture(id: string, posture: Record<string, unknown>): Promise<void> {
    await this.raw.run(
      'UPDATE providers SET account_json = ?, account_at = ? WHERE id = ?',
      JSON.stringify(posture),
      new Date().toISOString(),
      id,
    )
  }

  async countOpenIssues(providerId: string): Promise<number> {
    const row = await this.raw.get<{ n: number }>(
      "SELECT count(*) AS n FROM issues WHERE provider_id = ? AND status = 'open'",
      providerId,
    )
    return row?.n ?? 0
  }

  async countOpenHigh(providerId: string): Promise<number> {
    const row = await this.raw.get<{ n: number }>(
      "SELECT count(*) AS n FROM issues WHERE provider_id = ? AND status = 'open' AND severity = 'high'",
      providerId,
    )
    return row?.n ?? 0
  }

  async deleteProvider(id: string): Promise<void> {
    await this.raw.run('DELETE FROM providers WHERE id = ?', id)
    await this.raw.run('DELETE FROM buckets WHERE provider_id = ?', id)
    await this.raw.run('DELETE FROM issues WHERE provider_id = ?', id)
    await this.raw.run('DELETE FROM posture_changes WHERE provider_id = ?', id)
    await this.raw.run('DELETE FROM readings WHERE provider_id = ?', id)
    // Provider and bucket notes carry the provider id in `ref`. Remove them
    // with the account; an account-scoped memory cannot outlive its account.
    await this.raw.run('DELETE FROM notes WHERE ref = ? OR ref LIKE ?', id, `${id}/%`)
  }

  // -- buckets --------------------------------------------------------------

  async upsertBucket(
    providerId: string,
    name: string,
    posture: Record<string, unknown>,
    region: string | null = null,
  ): Promise<void> {
    const at = new Date().toISOString()
    await this.raw.run(
      `INSERT INTO buckets (provider_id, name, posture_json, posture_at, first_seen, last_seen, region, gone_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(provider_id, name) DO UPDATE SET
         posture_json = excluded.posture_json, posture_at = excluded.posture_at,
         last_seen = excluded.last_seen, region = coalesce(excluded.region, buckets.region),
         gone_at = NULL`,
      providerId,
      name,
      JSON.stringify(posture),
      at,
      at,
      at,
      region,
    )
  }

  /** Record that a complete listing no longer shows these buckets. */
  async markGone(providerId: string, names: string[]): Promise<void> {
    const at = new Date().toISOString()
    for (const name of names) {
      await this.raw.run(
        'UPDATE buckets SET gone_at = ? WHERE provider_id = ? AND name = ? AND gone_at IS NULL',
        at,
        providerId,
        name,
      )
    }
  }

  async insertChanges(
    providerId: string,
    bucket: string,
    changes: import('@shared/contract').PostureChange[],
  ): Promise<void> {
    if (!changes.length) return
    await this.raw.run(
      'INSERT INTO posture_changes (provider_id, bucket, at, changes_json) VALUES (?, ?, ?, ?)',
      providerId,
      bucket,
      changes[0]!.at,
      JSON.stringify(changes),
    )
  }

  async listChanges(
    providerId: string,
    since?: string | null,
  ): Promise<import('@shared/contract').PostureChange[]> {
    const rows = await this.raw.all<{ changes_json: string; at: string }>(
      since
        ? 'SELECT changes_json, at FROM posture_changes WHERE provider_id = ? AND at >= ? ORDER BY at DESC LIMIT 200'
        : 'SELECT changes_json, at FROM posture_changes WHERE provider_id = ? ORDER BY at DESC LIMIT 200',
      ...(since ? [providerId, since] : [providerId]),
    )
    const out: import('@shared/contract').PostureChange[] = []
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.changes_json) as import('@shared/contract').PostureChange[]
        if (Array.isArray(parsed)) out.push(...parsed)
      } catch {
        // A damaged historical row is not a reason to fail the current reading.
      }
    }
    return out.slice(0, 200)
  }

  async listIssueEvents(
    filter: {
      providerId?: string
      bucket?: string
      code?: string
      since?: string
      limit?: number
    } = {},
  ): Promise<IssueEventRecord[]> {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.providerId) {
      where.push('i.provider_id = ?')
      params.push(filter.providerId)
    }
    if (filter.bucket) {
      where.push('i.bucket = ?')
      params.push(filter.bucket)
    }
    if (filter.code) {
      where.push('i.code = ?')
      params.push(filter.code)
    }
    if (filter.since) {
      where.push('e.at >= ?')
      params.push(filter.since)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    params.push(Math.max(1, Math.min(filter.limit ?? 80, 500)))
    const rows = await this.raw.all<{
      id: string
      issue_id: string
      conversation_id: string | null
      kind: IssueEvent
      at: string
      detail_json: string | null
      provider_id: string
      bucket: string
      code: string
      severity: Severity
      status: IssueStatus
      last_seen_at: string
      issue_detail: string | null
    }>(
      `SELECT e.id, e.issue_id, e.conversation_id, e.kind, e.at, e.detail_json,
              i.provider_id, i.bucket, i.code, i.severity, i.status, i.last_seen_at,
              i.detail AS issue_detail
         FROM issue_events e
         JOIN issues i ON i.id = e.issue_id
         ${clause}
        ORDER BY e.at DESC
        LIMIT ?`,
      ...params,
    )
    return rows.map((row) => {
      let detail = row.issue_detail
      try {
        const parsed = row.detail_json ? (JSON.parse(row.detail_json) as unknown) : null
        if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
          const value = (parsed as { detail?: unknown }).detail
          if (typeof value === 'string') detail = value
        }
      } catch {
        // A damaged event payload still leaves the event's date and kind usable.
      }
      return {
        id: row.id,
        issue_id: row.issue_id,
        conversation_id: row.conversation_id,
        kind: row.kind,
        at: row.at,
        detail,
        provider_id: row.provider_id,
        bucket: row.bucket,
        code: row.code,
        severity: row.severity,
        status: row.status,
        last_seen_at: row.last_seen_at,
      }
    })
  }

  async insertReading(input: {
    conversationId: string | null
    providerId: string
    at: string
    trigger: ReadingTrigger
    complete: boolean
    visible: number
    processed: number
    pending: number
    denied: number
    unknown: number
    truncated: number
    openHigh: number
    openTotal: number
  }): Promise<ReadingRecord> {
    const record: ReadingRecord = {
      id: randomUUID(),
      conversation_id: input.conversationId,
      provider_id: input.providerId,
      at: input.at,
      trigger: input.trigger,
      complete: input.complete ? 1 : 0,
      visible: Math.max(0, input.visible),
      processed: Math.max(0, input.processed),
      pending: Math.max(0, input.pending),
      denied: Math.max(0, input.denied),
      unknown: Math.max(0, input.unknown),
      truncated: Math.max(0, input.truncated),
      open_high: Math.max(0, input.openHigh),
      open_total: Math.max(0, input.openTotal),
    }
    await this.raw.run(
      `INSERT INTO readings
        (id, conversation_id, provider_id, at, trigger, complete, visible, processed,
         pending, denied, unknown, truncated, open_high, open_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.conversation_id,
      record.provider_id,
      record.at,
      record.trigger,
      record.complete,
      record.visible,
      record.processed,
      record.pending,
      record.denied,
      record.unknown,
      record.truncated,
      record.open_high,
      record.open_total,
    )
    return record
  }

  async listReadings(
    filter: { providerId?: string; complete?: boolean; since?: string; limit?: number } = {},
  ): Promise<ReadingRecord[]> {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.providerId) {
      where.push('provider_id = ?')
      params.push(filter.providerId)
    }
    if (filter.complete !== undefined) {
      where.push('complete = ?')
      params.push(filter.complete ? 1 : 0)
    }
    if (filter.since) {
      where.push('at >= ?')
      params.push(filter.since)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    params.push(Math.max(1, Math.min(filter.limit ?? 100, 500)))
    return this.raw.all<ReadingRecord>(
      `SELECT * FROM readings ${clause} ORDER BY at DESC, id DESC LIMIT ?`,
      ...params,
    )
  }

  async latestCompleteReading(providerId?: string): Promise<ReadingRecord | undefined> {
    return providerId
      ? this.raw.get<ReadingRecord>(
          'SELECT * FROM readings WHERE provider_id = ? AND complete = 1 ORDER BY at DESC, id DESC LIMIT 1',
          providerId,
        )
      : this.raw.get<ReadingRecord>(
          'SELECT * FROM readings WHERE complete = 1 ORDER BY at DESC, id DESC LIMIT 1',
        )
  }

  async listBuckets(providerId: string): Promise<BucketRow[]> {
    return this.raw.all<BucketRow>(
      'SELECT * FROM buckets WHERE provider_id = ? AND gone_at IS NULL ORDER BY name',
      providerId,
    )
  }

  async countBuckets(providerId: string): Promise<number> {
    const row = await this.raw.get<{ n: number }>(
      'SELECT count(*) AS n FROM buckets WHERE provider_id = ? AND gone_at IS NULL',
      providerId,
    )
    return row?.n ?? 0
  }

  // -- issues ---------------------------------------------------------------

  async listIssues(
    filter: { providerId?: string; status?: IssueStatus; limit?: number } = {},
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
    params.push(Math.max(1, Math.min(filter.limit ?? 50, 1000)))
    return this.raw.all<IssueRecord>(
      `SELECT * FROM issues ${clause}
       ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                last_seen_at DESC, bucket, code
       LIMIT ?`,
      ...params,
    )
  }

  async issueStatuses(ids: string[]): Promise<Record<string, IssueStatus>> {
    const out: Record<string, IssueStatus> = {}
    for (let start = 0; start < ids.length; start += 200) {
      const chunk = ids.slice(start, start + 200)
      if (!chunk.length) break
      const rows = await this.raw.all<{ id: string; status: IssueStatus }>(
        `SELECT id, status FROM issues WHERE id IN (${chunk.map(() => '?').join(',')})`,
        ...chunk,
      )
      for (const row of rows) out[row.id] = row.status
    }
    return out
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

  /**
   * Record one rule observation. `observed` true opens or keeps an Issue; false
   * resolves it. An accepted Issue stays accepted while it is still observed:
   * acceptance belongs to the user, and only a clean reading ends it.
   */
  async upsertIssue(input: {
    providerId: string
    bucket: string
    code: string
    severity: Severity
    observed: boolean
    detail?: string | null
    conversationId: string | null
    resolution?: 'resolved' | 'gone'
  }): Promise<{ issue: IssueRecord | null; event: IssueEvent | null }> {
    const at = new Date().toISOString()
    const detail = input.detail ?? null
    const existing = await this.findIssue(input.providerId, input.bucket, input.code)
    if (input.observed) {
      if (!existing) {
        const id = randomUUID()
        await this.raw.run(
          `INSERT INTO issues (id, provider_id, bucket, code, severity, status, opened_at,
             resolved_at, last_seen_at, recurred, detail, accepted_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, ?, 0, ?, NULL)`,
          id,
          input.providerId,
          input.bucket,
          input.code,
          input.severity,
          at,
          at,
          detail,
        )
        await this.insertEvent(id, input.conversationId, 'opened', at, detail ? { detail } : null)
        return { issue: (await this.getIssue(id))!, event: 'opened' }
      }
      if (existing.status === 'resolved') {
        await this.raw.run(
          `UPDATE issues SET status = 'open', severity = ?, resolved_at = NULL, accepted_at = NULL,
             last_seen_at = ?, recurred = recurred + 1, detail = ? WHERE id = ?`,
          input.severity,
          at,
          detail,
          existing.id,
        )
        await this.insertEvent(
          existing.id,
          input.conversationId,
          'recurred',
          at,
          detail ? { detail } : null,
        )
        return { issue: (await this.getIssue(existing.id))!, event: 'recurred' }
      }
      await this.raw.run(
        'UPDATE issues SET severity = ?, last_seen_at = ?, detail = coalesce(?, detail) WHERE id = ?',
        input.severity,
        at,
        detail,
        existing.id,
      )
      return { issue: (await this.getIssue(existing.id))!, event: null }
    }
    if (existing && existing.status !== 'resolved') {
      const event = input.resolution ?? 'resolved'
      await this.raw.run(
        "UPDATE issues SET status = 'resolved', resolved_at = ?, last_seen_at = ? WHERE id = ?",
        at,
        at,
        existing.id,
      )
      await this.insertEvent(existing.id, input.conversationId, event, at, null)
      return { issue: (await this.getIssue(existing.id))!, event }
    }
    return { issue: existing ?? null, event: null }
  }

  /** The user accepts a risk, or takes the acceptance back. Never the model. */
  async setAccepted(id: string, accepted: boolean): Promise<IssueRecord | undefined> {
    const issue = await this.getIssue(id)
    if (!issue || issue.status === 'resolved') return issue
    const at = new Date().toISOString()
    if (accepted && issue.status === 'open') {
      await this.raw.run(
        "UPDATE issues SET status = 'accepted', accepted_at = ? WHERE id = ?",
        at,
        id,
      )
      await this.insertEvent(id, null, 'accepted', at, null)
    } else if (!accepted && issue.status === 'accepted') {
      await this.raw.run("UPDATE issues SET status = 'open', accepted_at = NULL WHERE id = ?", id)
      await this.insertEvent(id, null, 'reopened', at, null)
    }
    return this.getIssue(id)
  }

  async openIssuesFor(providerId: string, bucket: string): Promise<IssueRecord[]> {
    return this.raw.all<IssueRecord>(
      "SELECT * FROM issues WHERE provider_id = ? AND bucket = ? AND status != 'resolved'",
      providerId,
      bucket,
    )
  }

  async countIssues(status: IssueStatus): Promise<number> {
    const row = await this.raw.get<{ n: number }>(
      'SELECT count(*) AS n FROM issues WHERE status = ?',
      status,
    )
    return row?.n ?? 0
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
      await tx.run('UPDATE issue_events SET conversation_id = NULL WHERE conversation_id = ?', id)
      await tx.run('UPDATE readings SET conversation_id = NULL WHERE conversation_id = ?', id)
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
