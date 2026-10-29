import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { preview } from './dataset'
import { maskIp, normalizeTimestamp } from './formats'
import { importDataset, importInventoryFiles } from './import'

/** One read-only query over a dataset's file, as a script's sql() runs it. */
function sql<T>(path: string, query: string): T[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(query).all() as T[]
  } finally {
    db.close()
  }
}

/** Rows a dataset holds, read straight from its file. */
function countRows(path: string, kind: 'access_log' | 'inventory'): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const table = kind === 'inventory' ? 'inventory_objects' : 'access_logs'
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    db.close()
  }
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'sa-test-'))
}

describe('log formats', () => {
  it('normalizes epochs and CLF stamps to UTC', () => {
    expect(normalizeTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20Z')
    expect(normalizeTimestamp('14/Nov/2023:22:13:20 +0000')).toBe('2023-11-14T22:13:20Z')
    expect(normalizeTimestamp('14/Nov/2023:23:13:20 +0100')).toBe('2023-11-14T22:13:20Z')
  })

  it('masks the host part of an address', () => {
    expect(maskIp('203.0.113.42')).toBe('203.0.113.0')
    expect(maskIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::')
  })
})

describe('inventory import and aggregation', () => {
  it('sums bytes per storage class', async () => {
    const dir = temp()
    const csv = join(dir, 'inventory.csv')
    writeFileSync(
      csv,
      [
        '"bucket","key","size","storage_class","last_modified_date"',
        '"logs","a.bin",100,"STANDARD","2026-01-01T00:00:00Z"',
        '"logs","b.bin",200,"STANDARD","2026-01-02T00:00:00Z"',
        '"logs","c.bin",100,"GLACIER","2026-01-03T00:00:00Z"',
      ].join('\n'),
    )
    const db = join(dir, 'data.sqlite')
    const result = await importDataset({ filePath: csv, destPath: db, kind: 'inventory' })
    expect(result.rows).toBe(3)
    expect(countRows(db, 'inventory')).toBe(3)

    const byClass = sql<{ storage_class: string; total: number }>(
      db,
      'SELECT storage_class, sum(size) AS total FROM inventory_objects GROUP BY storage_class',
    )
    const totals = Object.fromEntries(byClass.map((row) => [row.storage_class, row.total]))
    expect(totals.STANDARD).toBe(300)
    expect(totals.GLACIER).toBe(100)
    expect(preview(db, 'inventory', 2).rows).toHaveLength(2)
  })

  it('imports every file of one inventory report into one dataset', async () => {
    const dir = temp()
    const first = join(dir, 'part-1.csv')
    const second = join(dir, 'part-2.csv')
    const header = '"bucket","key","size","storage_class","last_modified_date"\n'
    writeFileSync(first, `${header}"logs","a.bin",100,"STANDARD","2026-01-01"\n`)
    writeFileSync(second, `${header}"logs","b.bin",200,"GLACIER","2026-01-02"\n`)
    const db = join(dir, 'all.sqlite')
    const result = await importInventoryFiles({
      files: [first, second],
      destPath: db,
      fallbackBucket: 'logs',
    })
    expect(result.rows).toBe(2)
    expect(countRows(db, 'inventory')).toBe(2)
  })

  it('counts requests by status from a CSV log', async () => {
    const dir = temp()
    const csv = join(dir, 'access.csv')
    writeFileSync(
      csv,
      [
        'timestamp,method,path,status,bytes,latency_ms,remote_ip',
        '2026-02-01T10:00:00Z,GET,/a,200,10,5,203.0.113.9',
        '2026-02-01T10:00:01Z,GET,/b,200,20,7,203.0.113.9',
        '2026-02-01T10:00:02Z,PUT,/c,403,0,9,198.51.100.7',
        '2026-02-01T10:00:03Z,GET,/d,404,0,11,198.51.100.7',
      ].join('\n'),
    )
    const db = join(dir, 'logs.sqlite')
    const result = await importDataset({ filePath: csv, destPath: db, kind: 'access_log' })
    expect(result.rows).toBe(4)

    const byStatus = sql<{ status_code: number; n: number }>(
      db,
      'SELECT status_code, count(*) AS n FROM access_logs GROUP BY status_code',
    )
    const counts = Object.fromEntries(byStatus.map((row) => [String(row.status_code), row.n]))
    expect(counts['200']).toBe(2)
    expect(counts['403']).toBe(1)
    expect(counts['404']).toBe(1)
  })

  it('rejects an inventory disguised as access logs', async () => {
    const dir = temp()
    const csv = join(dir, 'inventory.csv')
    writeFileSync(csv, '"key","size","storage_class"\n"a",1,"STANDARD"\n')
    await expect(
      importDataset({ filePath: csv, destPath: join(dir, 'x.sqlite'), kind: 'access_log' }),
    ).rejects.toThrow(/inventory/i)
  })
})
