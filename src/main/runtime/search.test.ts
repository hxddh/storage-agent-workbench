import { searchRows } from '@shared/conversation'
import { describe, expect, it } from 'vitest'

describe('search rows', () => {
  it('indexes every message and every agent text of the conversation, once each', () => {
    const rows = searchRows([
      { id: 'u1', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'First', attachments: [] },
      { id: 'a1', kind: 'answer', at: '2026-01-01T00:00:01Z', text: '`demo` is public.' },
      { id: 's1', kind: 'steer', at: '2026-01-01T00:00:02Z', text: 'only demo', attachments: [] },
      { id: 'u2', kind: 'user', at: '2026-01-01T00:01:00Z', text: 'Second', attachments: [] },
      { id: 'a2', kind: 'answer', at: '2026-01-01T00:01:01Z', text: 'Nothing new.' },
      { id: 'e', kind: 'answer', at: '2026-01-01T00:01:02Z', text: '  ' },
    ])
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual([
      'user:First',
      'answer:`demo` is public.',
      'user:only demo',
      'user:Second',
      'answer:Nothing new.',
    ])
    expect(new Set(rows.map((row) => row.entryId)).size).toBe(rows.length)
  })
})
