import { describe, expect, it } from 'vitest'
import type { UiEntry } from './contract'
import { contradicted, knownNames, ungrounded } from './grounding'

const entries: UiEntry[] = [
  { id: 'u', kind: 'user', at: '', text: 'q', attachments: [{ name: 'access.log', bytes: 1 }] },
  {
    id: 't',
    kind: 'tool',
    at: '',
    name: 'objects',
    target: 'logs-bucket',
    status: 'done',
    note: null,
    ms: 1,
    view: { kind: 'objects', rows: { columns: ['Key'], rows: [['reports/a.csv']] } },
  },
  {
    id: 'f',
    kind: 'tool',
    at: '',
    name: 'config',
    target: 'never-read',
    status: 'failed',
    note: null,
    ms: 1,
    view: null,
  },
]

describe('grounding', () => {
  it('knows targets, table keys and attachments of finished checks only', () => {
    const known = knownNames(entries)
    expect([...known].sort()).toEqual(['access.log', 'logs-bucket', 'reports/a.csv'])
  })

  it('flags backticked names no check shows', () => {
    const known = knownNames(entries)
    expect(ungrounded('`logs-bucket` holds `reports/a.csv`; `never-read` too.', known)).toEqual([
      'never-read',
    ])
  })

  it('accepts a key under a known bucket and ignores code that is not a name', () => {
    const known = knownNames(entries)
    expect(ungrounded('`logs-bucket/2026/x.gz` and `aws s3api put-x --bucket y`', known)).toEqual(
      [],
    )
  })
})

describe('exposure claims', () => {
  const exposure = new Map([
    ['open-bucket', true],
    ['closed-bucket', false],
  ])

  it('flags a bucket called public that a reading proved private, and the reverse', () => {
    expect(contradicted('`closed-bucket` is publicly accessible.', exposure)).toEqual([
      'closed-bucket',
    ])
    expect(contradicted('`open-bucket` is not public.', exposure)).toEqual(['open-bucket'])
    expect(contradicted('`closed-bucket` 是公开的。', exposure)).toEqual(['closed-bucket'])
  })

  it('accepts true claims, including negation elsewhere in the sentence', () => {
    expect(
      contradicted(
        '`open-bucket` has no default encryption and is publicly accessible. `closed-bucket` is not public.',
        exposure,
      ),
    ).toEqual([])
    expect(contradicted('`closed-bucket` 不是公开的。', exposure)).toEqual([])
  })

  it('leaves sentences naming several buckets or unknown ones alone', () => {
    expect(contradicted('`open-bucket` and `closed-bucket` are public.', exposure)).toEqual([])
    expect(contradicted('`elsewhere` is public.', exposure)).toEqual([])
  })
})
