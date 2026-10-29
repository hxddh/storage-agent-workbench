import type { UiEntry } from '@shared/contract'
import { searchRows } from '@shared/trace'
import { describe, expect, it } from 'vitest'

const survey: UiEntry = {
  id: 'audit:0',
  kind: 'tool',
  at: '2026-01-01T00:00:01Z',
  name: 'survey',
  target: 'Demo',
  status: 'done',
  note: null,
  ms: null,
  evidenceId: 'audit:0',
  view: {
    kind: 'survey',
    provider: 'Demo',
    providerId: 'p1',
    buckets: {
      columns: ['Bucket', 'Public'],
      rows: [['demo', 'public']],
    },
    issues: [
      {
        id: 'i1',
        provider: 'Demo',
        bucket: 'demo',
        code: 'public_exposure',
        severity: 'high',
        status: 'open',
        title: 'Bucket is publicly accessible',
        detail: 'The provider reports the bucket policy as public',
        openedAt: '2026-01-01T00:00:00Z',
        lastSeenAt: '2026-01-01T00:00:00Z',
        recurred: 0,
      },
    ],
    observations: [],
    coverage: {
      visible: 1,
      processed: 1,
      truncated: false,
      pending: 0,
      denied: [],
      unknown: [],
      gone: [],
    },
    changed: { opened: 1, resolved: 0, recurred: 0 },
  },
}

describe('search docs', () => {
  it('indexes a scripted check without a user request', () => {
    const docs = searchRows([
      { id: 'run', kind: 'check', at: '2026-01-01T00:00:00Z', mode: 'check' },
      survey,
      {
        id: 'audit:answer',
        kind: 'answer',
        at: '2026-01-01T00:00:02Z',
        text: 'One issue is open.',
        source: 'check',
      },
    ])
    expect(docs.some((doc) => doc.text.includes('publicly accessible'))).toBe(true)
    expect(docs.some((doc) => doc.text === 'One issue is open.')).toBe(true)
    expect(new Set(docs.map((doc) => doc.entryId)).size).toBe(docs.length)
  })

  it('indexes findings of every run, not only the latest', () => {
    const docs = searchRows([
      { id: 'u1', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'First', attachments: [] },
      survey,
      { id: 'u2', kind: 'user', at: '2026-01-01T00:01:00Z', text: 'Second', attachments: [] },
      { id: 'a2', kind: 'answer', at: '2026-01-01T00:01:01Z', text: 'Nothing new.' },
    ])
    expect(docs.some((doc) => doc.kind === 'finding')).toBe(true)
    expect(docs.filter((doc) => doc.kind === 'user').map((doc) => doc.text)).toEqual([
      'First',
      'Second',
    ])
  })
})
