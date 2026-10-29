import { DatabaseSync } from 'node:sqlite'
import type { Table } from '@shared/contract'

export type DatasetKind = 'access_log' | 'inventory'

/** The table each kind of dataset imports into. */
export const TABLES: Record<DatasetKind, string> = {
  access_log: 'access_logs',
  inventory: 'inventory_objects',
}

export function preview(path: string, kind: DatasetKind, limit = 5): Table {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const table = TABLES[kind]
    const rows = db.prepare(`SELECT * FROM ${table} LIMIT ?`).all(limit) as Record<
      string,
      unknown
    >[]
    const columns =
      rows.length > 0
        ? Object.keys(rows[0]!)
        : (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    return {
      columns,
      rows: rows.map((row) =>
        columns.map((column) => (row[column] ?? null) as string | number | null),
      ),
    }
  } finally {
    db.close()
  }
}
