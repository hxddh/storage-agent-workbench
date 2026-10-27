import type { RunFacts } from '@shared/facts'
import { describe, expect, it } from 'vitest'
import { dict } from './i18n'
import { scopeText } from './scope'

function brief(overrides: Partial<RunFacts>): RunFacts {
  return {
    answer: null,
    findings: [],
    accepted: [],
    resolved: [],
    blind: [],
    undecided: [],
    data: null,
    changePlans: [],
    checks: [],
    methods: [],
    coverage: [],
    questions: [],
    changes: [],
    reverify: null,
    attribution: null,
    notices: [],
    durationMs: null,
    lastReadAt: null,
    lastAt: null,
    issueTotal: null,
    ...overrides,
  }
}

const t = dict('en')
const at = '2026-01-01T00:00:00Z'

describe('scope copy', () => {
  it('says all buckets checked only for complete coverage', () => {
    const text = scopeText(
      brief({
        coverage: [
          {
            provider: 'Demo',
            providerId: 'p1',
            accountBlock: null,
            capacity: null,
            issueTotal: null,
            visible: 2,
            processed: 2,
            pending: 0,
            denied: [],
            unknown: [],
            gone: [],
            truncated: false,
            at,
          },
        ],
        lastReadAt: at,
      }),
      t,
    )
    expect(text).toContain('All 2 buckets checked')
  })

  it('keeps all-bucket coverage visible when access questions stay open', () => {
    const text = scopeText(
      brief({
        coverage: [
          {
            provider: 'Demo',
            providerId: 'p1',
            accountBlock: null,
            capacity: null,
            issueTotal: null,
            visible: 6,
            processed: 6,
            pending: 0,
            denied: [],
            unknown: [],
            gone: [],
            truncated: false,
            at,
          },
        ],
        undecided: [
          {
            code: 'public_exposure',
            title: 'Bucket is publicly accessible',
            buckets: ['a'],
            count: 1,
          },
        ],
        blind: ['a', 'b', 'c'].map((bucket) => ({
          key: `blind:${bucket}`,
          bucket,
          title: 'Policy',
          aspect: 'access' as const,
          sourceId: 'e1',
        })),
        lastReadAt: at,
      }),
      t,
    )
    expect(text).toContain('All 6 buckets checked · 4 open questions · 3 blocked')
    expect(text).not.toContain('Not fully checked')
    expect(text).not.toContain('6/6 buckets checked')
  })

  it('says the answer came from memory instead of "no fresh read"', () => {
    const text = scopeText(
      brief({
        findings: [
          {
            key: 'issue:i1',
            provider: 'Demo',
            bucket: 'demo',
            code: 'public_exposure',
            title: 'Bucket is publicly accessible',
            detail: null,
            severity: 'high',
            control: null,
            issueId: 'i1',
            status: 'open',
            source: 'memory',
            readAt: at,
            recurred: 0,
            sourceId: 'e',
            sourceName: 'estate',
            at,
          },
        ],
      }),
      t,
    )
    expect(text).toContain('From memory')
    expect(text).not.toContain('No fresh account read')
  })

  it('never calls a narrowed read complete', () => {
    const text = scopeText(
      brief({
        coverage: [
          {
            provider: 'Demo',
            providerId: 'p1',
            accountBlock: null,
            capacity: null,
            issueTotal: null,
            visible: 3,
            processed: 2,
            pending: 1,
            denied: [],
            unknown: [],
            gone: [],
            truncated: true,
            at,
          },
        ],
      }),
      t,
    )
    expect(text).toContain('Not fully checked')
    expect(text).not.toContain('All 2 buckets checked')
  })
})
