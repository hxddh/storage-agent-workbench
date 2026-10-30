import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { columnsOf, importDataset, logTime, s3AccessFields, storedValue } from './import'

/** One read-only query over a dataset's file, as a script's sql() runs it. */
function sql<T>(path: string, query: string): T[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(query).all() as T[]
  } finally {
    db.close()
  }
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'sa-test-'))
}

const S3_LINE =
  '79a59df900b949e55d96a1e698fbacedfd6e09d98eacf8f8d5218e7cd47ef2be awsexamplebucket1 [06/Feb/2019:00:00:38 +0000] 192.0.2.3 arn:aws:iam::123456789012:user/alice 3E57427F3EXAMPLE REST.GET.VERSIONING - "GET /awsexamplebucket1?versioning HTTP/1.1" 200 - 113 - 7 - "-" "S3Console/0.4" - s9lzHYrFp76ZVxRcpX9+5cjAnEH2ROuNkd2BHfIa6UkFVdtjf5mKR3/eTPFvsiP/XV/VLi31234= SigV4 ECDHE-RSA-AES128-GCM-SHA256 AuthHeader awsexamplebucket1.s3.us-west-1.amazonaws.com TLSV1.2 - -'

describe('lossless datasets', () => {
  it('keeps every column of a CSV, typed where the text reads back the same', async () => {
    const dir = temp()
    const csv = join(dir, 'inventory.csv')
    writeFileSync(
      csv,
      [
        'Bucket,Key,Size,StorageClass,EncryptionStatus,ETag,ZipCode',
        'logs,a.bin,100,STANDARD,SSE-S3,"abc",01234',
        'logs,b.bin,200,STANDARD,NOT-SSE,"def",02134',
        'logs,c.bin,123456789012,GLACIER,SSE-KMS,"ghi",30000',
      ].join('\n'),
    )
    const db = join(dir, 'data.sqlite')
    const result = await importDataset([{ path: csv, label: 'inventory.csv' }], db)
    expect(result.format).toBe('csv')
    expect(result.rows).toBe(3)
    expect(result.columns).toEqual([
      '_source',
      'Bucket',
      'Key',
      'Size',
      'StorageClass',
      'EncryptionStatus',
      'ETag',
      'ZipCode',
    ])
    const byClass = sql<{ StorageClass: string; total: number }>(
      db,
      'SELECT StorageClass, sum(Size) AS total FROM rows GROUP BY StorageClass ORDER BY StorageClass',
    )
    // A 12-digit size is a quantity, not an account id.
    expect(byClass).toEqual([
      { StorageClass: 'GLACIER', total: 123456789012 },
      { StorageClass: 'STANDARD', total: 300 },
    ])
    const plain = sql<{ EncryptionStatus: string; ZipCode: string }>(
      db,
      "SELECT EncryptionStatus, ZipCode FROM rows WHERE Key = 'b.bin'",
    )
    expect(plain).toEqual([{ EncryptionStatus: 'NOT-SSE', ZipCode: '02134' }])
  })

  it('names a header-less CSV by the columns given, as an inventory manifest does', async () => {
    const dir = temp()
    const csv = join(dir, 'part.csv.gz')
    writeFileSync(csv, gzipSync('"logs","a.bin","100","true"\n"logs","b.bin","5","false"\n'))
    const db = join(dir, 'inv.sqlite')
    const result = await importDataset([{ path: csv, label: 's3://dest/part.csv.gz' }], db, {
      format: 'csv',
      columns: ['Bucket', 'Key', 'Size', 'IsLatest'],
      header: false,
    })
    expect(result.rows).toBe(2)
    expect(sql(db, 'SELECT Key, Size, IsLatest, _source FROM rows ORDER BY Key')).toEqual([
      { Key: 'a.bin', Size: 100, IsLatest: 'true', _source: 's3://dest/part.csv.gz' },
      { Key: 'b.bin', Size: 5, IsLatest: 'false', _source: 's3://dest/part.csv.gz' },
    ])
  })

  it('splits every field of an S3 server access log, with the account scrubbed', async () => {
    expect(s3AccessFields(S3_LINE)?.[6]).toBe('REST.GET.VERSIONING')
    expect(logTime('06/Feb/2019:00:00:38 +0000')).toBe('2019-02-06T00:00:38Z')
    const dir = temp()
    const log = join(dir, '2019-02-06-00-00-38-ABC')
    writeFileSync(log, `${S3_LINE}\n`)
    const db = join(dir, 'log.sqlite')
    const result = await importDataset([{ path: log, label: 'log' }], db)
    expect(result.format).toBe('s3_access_log')
    const [row] = sql<Record<string, unknown>>(db, 'SELECT * FROM rows')
    expect(row).toMatchObject({
      bucket: 'awsexamplebucket1',
      remote_ip: '192.0.2.3',
      requester: 'arn:aws:iam::<account>:user/alice',
      operation: 'REST.GET.VERSIONING',
      request_uri: 'GET /awsexamplebucket1?versioning HTTP/1.1',
      http_status: 200,
      bytes_sent: 113,
      total_time: 7,
      user_agent: 'S3Console/0.4',
      signature_version: 'SigV4',
      tls_version: 'TLSV1.2',
      time_iso: '2019-02-06T00:00:38Z',
    })
    expect(String(row?.raw)).toContain('REST.GET.VERSIONING')
    expect(String(row?.raw)).not.toContain('123456789012')
  })

  it('takes every key of JSON lines, nested values as JSON, and keeps a bad line', async () => {
    const dir = temp()
    const file = join(dir, 'events.jsonl')
    writeFileSync(file, ['{"a":1,"b":{"c":2}}', '{"a":2,"d":"new"}', 'not json'].join('\n'))
    const db = join(dir, 'j.sqlite')
    const result = await importDataset([{ path: file, label: 'events.jsonl' }], db)
    expect(result.rows).toBe(3)
    expect(columnsOf(db)).toEqual(['_source', 'a', 'b', 'd', '_line'])
    expect(sql(db, 'SELECT a, b, d, _line FROM rows')).toEqual([
      { a: 1, b: '{"c":2}', d: null, _line: null },
      { a: 2, b: null, d: 'new', _line: null },
      { a: null, b: null, d: null, _line: 'not json' },
    ])
  })

  it('reads anything else as lines', async () => {
    const dir = temp()
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'first line\nsecond line\n')
    const db = join(dir, 'l.sqlite')
    const result = await importDataset([{ path: file, label: 'notes.txt' }], db)
    expect(result.format).toBe('lines')
    expect(sql(db, 'SELECT line_no, line FROM rows')).toEqual([
      { line_no: 1, line: 'first line' },
      { line_no: 2, line: 'second line' },
    ])
  })

  it('never stores an account id as text', () => {
    expect(storedValue('Owner', '123456789012')).toBe('<account>')
    expect(storedValue('Size', '123456789012')).toBe(123456789012)
    expect(storedValue('Note', 'AKIAABCDEFGHIJKLMNOP')).toBe('AKIA[redacted]')
  })
})
