/**
 * The agent's memory.
 *
 * A separate SQLite file, so a script's SQL can never reach the host tables
 * that hold accounts, task metadata or sealed secret references. Documents are
 * arbitrary JSON; the agent decides their keys and shape. The window lists
 * them in Settings and can forget one.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryRow, NoteRow } from '@shared/contract'
import { checkSql } from './sql'

export interface MemoryDoc {
  id: string
  scope: 'task' | 'user'
  conversationId: string | null
  key: string
  value: unknown
  text: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  scope: string
  conversation_id: string | null
  key: string
  value_json: string
  text: string
  tags_json: string
  created_at: string
  updated_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  conversation_id TEXT,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  text TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, conversation_id, key)
);
CREATE INDEX IF NOT EXISTS docs_key ON docs (key);
CREATE INDEX IF NOT EXISTS docs_scope ON docs (scope, conversation_id);
`

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 1)
  } catch {
    return String(value)
  }
}

function doc(row: Row): MemoryDoc {
  let value: unknown = null
  try {
    value = JSON.parse(row.value_json)
  } catch {
    value = row.value_json
  }
  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags_json) as unknown
    if (Array.isArray(parsed))
      tags = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    // A malformed tag list is no tags.
  }
  return {
    id: row.id,
    scope: row.scope === 'task' ? 'task' : 'user',
    conversationId: row.conversation_id,
    key: row.key,
    value,
    text: row.text,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class MemoryStore {
  private readonly db: DatabaseSync

  private constructor(
    readonly path: string,
    db: DatabaseSync,
  ) {
    this.db = db
  }

  static open(path: string): MemoryStore {
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(SCHEMA)
    return new MemoryStore(path, db)
  }

  put(input: {
    key: string
    value: unknown
    text?: string
    tags?: string[]
    scope?: 'task' | 'user'
    conversationId?: string | null
  }): MemoryDoc {
    const key = input.key.trim().slice(0, 300)
    if (!key) throw new Error('memory key is required.')
    const scope = input.scope === 'task' ? 'task' : 'user'
    const conversationId = scope === 'task' ? (input.conversationId ?? null) : null
    if (scope === 'task' && !conversationId) throw new Error('task memory needs a conversation.')
    const at = new Date().toISOString()
    const existing = this.db
      .prepare(`SELECT * FROM docs WHERE scope = ? AND conversation_id IS ? AND key = ?`)
      .get(scope, conversationId, key) as unknown as Row | undefined
    const valueJson = JSON.stringify(input.value ?? null)
    const text = (input.text?.trim() || textOf(input.value)).slice(0, 200_000)
    const tags = (input.tags ?? []).filter((tag) => typeof tag === 'string').slice(0, 32)
    if (existing) {
      this.db
        .prepare(
          `UPDATE docs SET value_json = ?, text = ?, tags_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(valueJson, text, JSON.stringify(tags), at, existing.id)
      return doc({
        ...existing,
        value_json: valueJson,
        text,
        tags_json: JSON.stringify(tags),
        updated_at: at,
      })
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO docs (id, scope, conversation_id, key, value_json, text, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, scope, conversationId, key, valueJson, text, JSON.stringify(tags), at, at)
    return doc({
      id,
      scope,
      conversation_id: conversationId,
      key,
      value_json: valueJson,
      text,
      tags_json: JSON.stringify(tags),
      created_at: at,
      updated_at: at,
    })
  }

  get(
    key: string,
    scope: 'task' | 'user' = 'user',
    conversationId?: string | null,
  ): MemoryDoc | null {
    const row = this.db
      .prepare(`SELECT * FROM docs WHERE scope = ? AND conversation_id IS ? AND key = ?`)
      .get(scope, scope === 'task' ? (conversationId ?? null) : null, key) as unknown as
      | Row
      | undefined
    return row ? doc(row) : null
  }

  list(
    input: {
      scope?: 'task' | 'user'
      conversationId?: string | null
      prefix?: string
      tag?: string
      limit?: number
    } = {},
  ): MemoryDoc[] {
    const clauses: string[] = []
    const params: (string | number | null)[] = []
    if (input.scope) {
      clauses.push('scope = ?')
      params.push(input.scope)
      clauses.push('conversation_id IS ?')
      params.push(input.scope === 'task' ? (input.conversationId ?? null) : null)
    }
    if (input.prefix) {
      clauses.push("key LIKE ? ESCAPE '\\'")
      params.push(`${input.prefix.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
    }
    if (input.tag) {
      clauses.push('tags_json LIKE ?')
      params.push(`%${JSON.stringify(input.tag).slice(1, -1)}%`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
    const rows = this.db
      .prepare(`SELECT * FROM docs ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as Row[]
    return rows.map(doc)
  }

  search(query: string, limit = 20): MemoryDoc[] {
    const needle = query.trim()
    if (!needle) return []
    const rows = this.db
      .prepare(
        `SELECT * FROM docs WHERE text LIKE ? OR key LIKE ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(
        `%${needle.replace(/[%_\\]/g, (m) => `\\${m}`)}%`,
        `%${needle}%`,
        Math.max(1, Math.min(limit, 100)),
      ) as unknown as Row[]
    return rows.map(doc)
  }

  /** One read-only SELECT over the docs table. */
  query(sql: string, params: (string | number | null)[] = []): Record<string, unknown>[] {
    checkSql(sql)
    const db = new DatabaseSync(this.path, { readOnly: true })
    try {
      return db.prepare(sql).all(...params) as Record<string, unknown>[]
    } finally {
      db.close()
    }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM docs WHERE id = ?').run(id)
  }

  deleteTask(conversationId: string): void {
    this.db
      .prepare("DELETE FROM docs WHERE scope = 'task' AND conversation_id = ?")
      .run(conversationId)
  }

  deleteByKey(key: string, scope: 'task' | 'user' = 'user', conversationId?: string | null): void {
    this.db
      .prepare(`DELETE FROM docs WHERE scope = ? AND conversation_id IS ? AND key = ?`)
      .run(scope, scope === 'task' ? (conversationId ?? null) : null, key)
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM docs').get() as { n: number }
    return row.n
  }

  /** The window's list: every document, newest first. */
  rows(): MemoryRow[] {
    return this.list({ limit: 500 }).map((item) => ({
      id: item.id,
      key: item.key,
      scope: item.scope,
      text: item.text,
      createdAt: item.createdAt,
    }))
  }

  /** Bring v37 notes into the memory file once. */
  importNotes(notes: readonly NoteRow[]): void {
    for (const note of notes) {
      const key = `note:${note.id}`
      if (this.get(key)) continue
      this.put({ key, value: note.text, text: note.text, tags: ['note'], scope: 'user' })
    }
  }

  close(): void {
    this.db.close()
  }
}
