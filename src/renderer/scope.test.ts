import { at, issue, request, survey, tool } from '@shared/testing'
import { buildTrace } from '@shared/trace'
import { describe, expect, it } from 'vitest'
import { dict } from './i18n'
import { scopeText } from './scope'

const t = dict('en')

describe('scope copy', () => {
  it('says all buckets checked only for complete coverage', () => {
    const trace = buildTrace([request(), tool('survey', survey(['a', 'b']))])
    expect(scopeText(trace, t)).toContain('All 2 buckets checked')
  })

  it('keeps all-bucket coverage visible when access questions stay open', () => {
    const trace = buildTrace([
      request(),
      tool(
        'survey',
        survey(['a', 'b', 'c', 'd', 'e', 'f'], {
          undecided: [
            { bucket: 'a', code: 'public_exposure', title: 'Bucket is publicly accessible' },
          ],
        }),
      ),
      ...['a', 'b', 'c'].map((bucket) =>
        tool('config', {
          kind: 'config',
          bucket,
          providerId: 'p1',
          aspect: 'access',
          findings: [{ severity: 'blind', title: 'Policy', detail: '', code: 'blind:policy' }],
        }),
      ),
    ])
    const text = scopeText(trace, t)
    expect(text).toContain('All 6 buckets checked · 4 open questions · 3 blocked')
    expect(text).not.toContain('Not fully checked')
    expect(text).not.toContain('6/6 buckets checked')
  })

  it('says the answer came from memory instead of "no fresh read"', () => {
    const trace = buildTrace([
      request('What did you find last time?'),
      tool('estate', {
        kind: 'estate',
        providerId: 'p1',
        buckets: null,
        issues: [issue('demo', 'public_exposure', { lastSeenAt: at(-86_400) })],
        notes: [],
      }),
    ])
    const text = scopeText(trace, t)
    expect(text).toContain('From memory')
    expect(text).not.toContain('No fresh account read')
  })

  it('never calls a stopped or narrowed read complete', () => {
    const stopped = buildTrace([
      request(),
      tool('survey', survey(['a', 'b'], { coverage: { visible: 3, pending: 1, truncated: true } })),
    ])
    expect(scopeText(stopped, t)).toContain('Not fully checked')
    const narrowed = buildTrace([
      request('I applied the fix'),
      tool('survey', survey(['a'], { scoped: true })),
    ])
    expect(scopeText(narrowed, t)).not.toContain('All 1 bucket')
    expect(scopeText(narrowed, t)).toContain('Live read')
  })

  it('keeps a failed storage read open', () => {
    const trace = buildTrace([
      request(),
      tool('survey', survey(['a'])),
      tool('config', null, { status: 'failed', target: 'a' }),
    ])
    expect(scopeText(trace, t)).not.toContain('All 1 bucket checked')
  })
})
