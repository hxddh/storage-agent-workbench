import type { UiEntry } from '@shared/contract'
import { describe, expect, it } from 'vitest'
import { buildRun } from './run'

const at = '2026-01-01T00:00:00Z'

const survey: UiEntry = {
  id: 'survey',
  kind: 'tool',
  at,
  name: 'survey',
  target: 'Demo',
  status: 'done',
  note: null,
  ms: 10,
  evidenceId: 'ev-survey',
  view: {
    kind: 'survey',
    provider: 'Demo',
    providerId: 'p1',
    buckets: { columns: ['Bucket'], rows: [['demo']] },
    issues: [],
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
    changed: { opened: 0, resolved: 0, recurred: 0 },
  },
}

const answer = (text: string): UiEntry => ({
  id: 'answer',
  kind: 'answer',
  at,
  text,
})

const user: UiEntry = {
  id: 'u',
  kind: 'user',
  at,
  text: 'Which buckets are public?',
  attachments: [],
}

describe('answer protocol', () => {
  it('keeps normal Markdown and resolves its cited evidence', () => {
    const run = buildRun([user, survey, answer('Only `demo` is public [1](#ev-ev-survey).')])
    expect(run.answer?.text).toContain('Only `demo` is public')
    expect(run.answer?.unresolvedCitations).toBe(0)
  })

  it('reports a citation that does not resolve', () => {
    const run = buildRun([user, survey, answer('Only `demo` is public [1](#ev-missing).')])
    expect(run.answer?.unresolvedCitations).toBe(1)
  })

  it('does not treat a pre-question answer as current', () => {
    const run = buildRun([answer('Old answer.'), user, survey])
    expect(run.answer?.text).toBe('Old answer.')
    expect(run.answer?.stale).toBe(true)
  })
})
