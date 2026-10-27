import type { UiEntry } from '@shared/contract'
import { describe, expect, it } from 'vitest'
import { searchDocsFor } from './search'

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
  it('indexes a model-free audit without a user request', () => {
    const docs = searchDocsFor([
      survey,
      {
        id: 'audit:answer',
        kind: 'answer',
        at: '2026-01-01T00:00:02Z',
        text: 'One issue is open.',
      },
    ])
    expect(docs.some((doc) => doc.text.includes('publicly accessible'))).toBe(true)
    expect(docs.some((doc) => doc.text === 'One issue is open.')).toBe(true)
    expect(new Set(docs.map((doc) => doc.entryId)).size).toBe(docs.length)
  })
})
