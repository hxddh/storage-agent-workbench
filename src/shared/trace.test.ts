import { describe, expect, it } from 'vitest'
import type { Live, UiEntry } from './contract'
import { answer, check, issue, request, survey, tool } from './testing'
import { buildTrace, earlierRuns, traceMarkdown } from './trace'

const open = (buckets: string[], issues = buckets.map((bucket) => issue(bucket))) =>
  tool('survey', survey(buckets, { issues, issueTotal: issues.length }))

describe('findings', () => {
  it('orders by severity and keeps each finding once', () => {
    const trace = buildTrace([
      request(),
      open(['a', 'b'], [issue('a', 'no_encryption'), issue('b'), issue('b')]),
    ])
    expect(trace.findings.map((item) => `${item.bucket}:${item.severity}`)).toEqual([
      'b:high',
      'a:medium',
    ])
    expect(trace.counts).toEqual({ high: 1, medium: 1, low: 0 })
  })

  it('removes a finding a later reading proved fixed, and folds it as resolved', () => {
    const trace = buildTrace([
      request(),
      open(['a']),
      tool(
        'survey',
        survey(['a'], {
          scoped: true,
          issues: [],
          issueTotal: 0,
          observations: [{ provider: 'p1', bucket: 'a', code: 'public_exposure', verdict: false }],
        }),
      ),
    ])
    expect(trace.findings).toEqual([])
    expect(trace.resolved.map((item) => item.bucket)).toEqual(['a'])
  })

  it('keeps the resolved fold across runs: an earlier run saw it, this one proved it fixed', () => {
    const trace = buildTrace([
      request(),
      open(['a']),
      request('I applied the fix'),
      tool(
        'survey',
        survey(['a'], {
          scoped: true,
          issues: [],
          issueTotal: 0,
          observations: [{ provider: 'p1', bucket: 'a', code: 'public_exposure', verdict: false }],
        }),
      ),
    ])
    expect(trace.findings).toEqual([])
    expect(trace.resolved).toHaveLength(1)
  })

  it('marks memory apart from a fresh read', () => {
    const trace = buildTrace([
      request(),
      tool('survey', survey(['a'], { issues: [issue('a'), issue('unread')], issueTotal: 2 })),
    ])
    expect(Object.fromEntries(trace.findings.map((item) => [item.bucket, item.source]))).toEqual({
      a: 'read',
      unread: 'memory',
    })
  })

  it('lays the estate status over the readings: accepted folds, resolved elsewhere leaves', () => {
    const entries = [request(), open(['a', 'b'])]
    const trace = buildTrace(entries, null, {
      'i-a-public_exposure': 'accepted',
      'i-b-public_exposure': 'resolved',
    })
    expect(trace.findings).toEqual([])
    expect(trace.accepted.map((item) => item.bucket)).toEqual(['a'])
  })

  it('keeps findings a survey left out when its Issue list was cut short', () => {
    const trace = buildTrace([
      request(),
      open(['a', 'b']),
      tool('survey', survey(['a', 'b'], { issues: [issue('a')], issueTotal: 2 })),
    ])
    expect(trace.findings.map((item) => item.bucket).sort()).toEqual(['a', 'b'])
  })

  it('belongs to the current run', () => {
    const trace = buildTrace([request(), open(['a']), request('Something else'), answer('Done.')])
    expect(trace.findings).toEqual([])
  })
})

describe('the run', () => {
  it('has a request, or a scripted trigger and no request', () => {
    expect(buildTrace([request('Q')]).request?.text).toBe('Q')
    const scripted = buildTrace([check(), open(['a']), answer('1 risk.', 'check')])
    expect(scripted.request).toBeNull()
    expect(scripted.scripted).toBe('check')
    expect(scripted.answer?.synthesized).toBe(true)
  })

  it('keeps every call and validation in order, and counts calls without plan or methods', () => {
    const entries: UiEntry[] = [
      request(),
      tool('plan', { kind: 'plan', steps: [{ title: 'Read', status: 'active' }] }),
      tool('skill', {
        kind: 'skill',
        name: 'access',
        title: 'Access',
        description: '',
        body: '',
      }),
      open(['a']),
      { id: 'v', kind: 'validation', at: '', text: 'Cite it.', tone: 'warn' },
      answer('`a` is public.'),
    ]
    const trace = buildTrace(entries)
    expect(trace.items.map((item) => item.kind)).toEqual(['tool', 'tool', 'validation'])
    expect(trace.calls).toBe(1)
    expect(trace.plan?.steps).toHaveLength(1)
    expect(trace.answer?.check.uncited).toEqual(['a'])
  })

  it('streams the answer from the live slot and adds running calls', () => {
    const live: Live = {
      phase: 'writing',
      tools: [
        {
          callId: 'x',
          name: 'config',
          target: 'a',
          note: null,
          status: 'running',
          startedAt: '2026-01-01T00:00:00Z',
        },
      ],
      reasoning: null,
      text: 'Partial',
      startedAt: '2026-01-01T00:00:00Z',
    }
    const trace = buildTrace([request()], live)
    expect(trace.answer).toMatchObject({ text: 'Partial', streaming: true })
    expect(trace.phase).toBe('answering')
    expect(trace.read.running).toBe(true)
  })

  it('only keeps notices after the latest resume', () => {
    const notice = (id: string, code: 'stopped' | 'failed'): UiEntry => ({
      id,
      kind: 'notice',
      at: '',
      code,
      text: '',
      tone: 'info',
    })
    const trace = buildTrace([
      request(),
      notice('n1', 'stopped'),
      { id: 'r', kind: 'resume', at: '' },
      answer('Done.'),
    ])
    expect(trace.notices).toEqual([])
    expect(trace.phase).toBe('settled')
  })

  it('summarises earlier runs, scripted or asked', () => {
    const runs = earlierRuns([
      check(),
      open(['a']),
      answer('1 risk.', 'check'),
      request('Why?'),
      answer('Because.'),
      request('Now?'),
    ])
    expect(runs.map((run) => run.request ?? run.scripted)).toEqual(['check', 'Why?'])
    expect(runs[0]?.counts.high).toBe(1)
  })

  it('saves the answer, then the trace and what stayed open', () => {
    const text = traceMarkdown(
      buildTrace([
        request(),
        tool('survey', survey(['a'], { coverage: { denied: ['a'] } })),
        answer('Not all read.'),
      ]),
    )
    expect(text.split('\n\n')[0]).toBe('Not all read.')
    expect(text).toContain('## Trace')
    expect(text).toContain('## Not checked')
  })
})
