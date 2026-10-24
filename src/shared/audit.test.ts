import { describe, expect, it } from 'vitest'
import { auditVerdict } from './audit'
import type { ToolView } from './contract'

function survey(overrides: Partial<Extract<ToolView, { kind: 'survey' }>> = {}) {
  const view: Extract<ToolView, { kind: 'survey' }> = {
    kind: 'survey',
    provider: 'Demo',
    buckets: { columns: ['bucket'], rows: [] },
    issues: [],
    coverage: { visible: 0, processed: 0, truncated: false, denied: [], unknown: [] },
    changed: { opened: 0, resolved: 0, recurred: 0 },
    ...overrides,
  }
  return view
}

function issue(bucket: string, severity: 'high' | 'medium' | 'low') {
  return {
    id: `${bucket}:${severity}`,
    provider: 'p',
    bucket,
    code: 'public_exposure',
    severity,
    status: 'open' as const,
    title: 'Bucket is publicly accessible',
    detail: '',
    openedAt: '',
    lastSeenAt: '',
    recurred: 0,
  }
}

describe('audit verdict', () => {
  it('never closes the question when a read was incomplete', () => {
    const text = auditVerdict(
      [
        survey({
          coverage: {
            visible: 2,
            processed: 2,
            truncated: false,
            denied: ['private'],
            unknown: [],
          },
        }),
      ],
      undefined,
      'en',
    )
    expect(text).toMatch(/cannot close|incomplete/i)
    expect(text).not.toMatch(/^No open issue/i)
  })

  it('names the issue count, severity and buckets it actually read', () => {
    const text = auditVerdict(
      [
        survey({
          issues: [issue('demo-public', 'high'), issue('demo-private', 'medium')],
          coverage: { visible: 2, processed: 2, truncated: false, denied: [], unknown: [] },
        }),
      ],
      { examined: 2, total: 2 },
      'en',
    )
    expect(text).toContain('2 issues')
    expect(text).toContain('(1 high)')
    expect(text).toContain('`demo-public`')
    expect(text).toContain('`demo-private`')
  })

  it('states the reverse-query access coverage when it is partial', () => {
    const text = auditVerdict(
      [
        survey({
          coverage: { visible: 3, processed: 3, truncated: false, denied: [], unknown: [] },
        }),
      ],
      { examined: 1, total: 3 },
      'zh',
    )
    expect(text).toContain('1/3')
  })
})
