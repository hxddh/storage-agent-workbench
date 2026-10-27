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

const answer = (text: string, show: string[]): UiEntry => ({
  id: 'answer',
  kind: 'tool',
  at,
  name: 'answer',
  target: 'answer',
  status: 'done',
  note: null,
  ms: 0,
  view: { kind: 'report', text, show, blocks: [] },
})

const user: UiEntry = {
  id: 'u',
  kind: 'user',
  at,
  text: 'Which buckets are public?',
  attachments: [],
}

describe('answer protocol', () => {
  it('keeps normal Markdown and resolves its evidence', () => {
    const run = buildRun([user, survey, answer('Only `demo` is public [1](#ev-1).', ['ev-survey'])])
    expect(run.report?.text).toContain('Only `demo` is public')
    expect(run.report?.show).toEqual(['ev-survey'])
    expect(run.report?.unresolved).toBe(0)
    expect(run.report?.unresolvedCitations).toBe(0)
  })

  it('omits a missing show id and counts it', () => {
    const run = buildRun([user, survey, answer('The bucket is `demo`.', ['missing'])])
    expect(run.report?.unresolved).toBe(1)
    expect(run.report?.show).toEqual(['missing'])
  })

  it('reports a citation that does not resolve', () => {
    const run = buildRun([user, survey, answer('Only `demo` is public [1](#ev-9).', ['ev-survey'])])
    expect(run.report?.unresolvedCitations).toBe(1)
  })

  it('keeps a legacy answer as a block report for older tasks', () => {
    const legacy: UiEntry = {
      ...survey,
      id: 'legacy',
      name: 'report',
      view: {
        kind: 'report',
        blocks: [{ kind: 'summary', text: 'Only `demo` is public.', evidence: ['ev-survey'] }],
      },
    }
    const run = buildRun([user, survey, legacy])
    expect(run.report?.text).toBeNull()
    expect(run.report?.blocks).toHaveLength(1)
  })
})
