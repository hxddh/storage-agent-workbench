import { briefSearchText, buildBrief } from '@shared/brief'
import type { IssueRow, Observation, ToolView, UiEntry } from '@shared/contract'
import { describe, expect, it } from 'vitest'

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString()

const issue = (
  id: string,
  severity: 'high' | 'medium' | 'low',
  bucket: string,
  code = `code-${id}`,
): IssueRow => ({
  id,
  provider: 'p1',
  bucket,
  code,
  severity,
  status: 'open',
  title: `Issue ${id}`,
  detail: null,
  openedAt: at(0),
  lastSeenAt: at(1),
  recurred: 0,
})

const tool = (
  id: string,
  name: Extract<UiEntry, { kind: 'tool' }>['name'],
  time: string,
  view: ToolView | null,
  ms = 100,
  status: Extract<UiEntry, { kind: 'tool' }>['status'] = 'done',
): UiEntry => ({ id, kind: 'tool', at: time, name, target: 'acme', status, note: null, ms, view })

const survey = (
  issues: IssueRow[],
  options: {
    read?: string[]
    observations?: Observation[]
    denied?: string[]
    pending?: number
  } = {},
): ToolView => ({
  kind: 'survey',
  provider: 'acme',
  providerId: 'p1',
  buckets: { columns: ['Bucket'], rows: (options.read ?? ['demo', 'prod']).map((b) => [b]) },
  issues,
  observations: options.observations ?? [],
  coverage: {
    visible: 3,
    processed: 3,
    truncated: false,
    pending: options.pending ?? 0,
    denied: options.denied ?? [],
    unknown: [],
    gone: [],
  },
  changed: { opened: 0, resolved: 0, recurred: 0 },
})

const user = (id: string, time: string, text = 'what is public?'): UiEntry => ({
  id,
  kind: 'user',
  at: time,
  text,
  attachments: [],
})

const answer = (id: string, time: string, text: string): UiEntry => ({
  id,
  kind: 'answer',
  at: time,
  text,
})

const fix = (bucket: string, code: string): ToolView => ({
  kind: 'fix',
  providerId: 'p1',
  bucket,
  code,
  formats: [{ label: 'AWS CLI', language: 'bash', text: 'aws s3api …' }],
  impact: { verdict: 'caution', reasons: ['reads break'], gap: null },
})

describe('brief projection', () => {
  it('orders findings by severity and indexes each once', () => {
    const brief = buildBrief([
      user('u1', at(0)),
      tool(
        't1',
        'survey',
        at(1),
        survey([issue('a', 'medium', 'demo'), issue('b', 'high', 'prod')]),
      ),
      answer('a1', at(3), 'Two buckets need attention.'),
    ])
    expect(brief.findings.map((finding) => finding.key)).toEqual(['issue:b', 'issue:a'])
    const docs = briefSearchText(brief).filter((doc) => doc.kind === 'finding')
    expect(new Set(docs.map((doc) => doc.entryId)).size).toBe(2)
    expect(brief.verdict).toMatchObject({ text: 'Two buckets need attention.', streaming: false })
  })

  it('removes a finding a later survey proved fixed, and says so', () => {
    const exposed = issue('x', 'high', 'demo', 'public_exposure')
    const brief = buildBrief([
      user('u1', at(0)),
      tool('t1', 'survey', at(1), survey([exposed])),
      tool('t2', 'fix', at(2), fix('demo', 'public_exposure')),
      user('u2', at(3), 'I applied it, check again'),
      tool(
        't3',
        'survey',
        at(4),
        survey([], {
          read: ['demo'],
          observations: [
            { provider: 'p1', bucket: 'demo', code: 'public_exposure', verdict: false },
          ],
        }),
      ),
    ])
    expect(brief.findings).toHaveLength(0)
    expect(brief.resolved.map((finding) => finding.key)).toEqual(['issue:x'])
    expect(brief.fixes).toHaveLength(0)
  })

  it('collapses the review finding that produced an issue into that issue', () => {
    const exposed = issue('x', 'high', 'demo', 'public_exposure')
    const brief = buildBrief([
      user('u1', at(0)),
      tool('t1', 'survey', at(1), survey([exposed])),
      tool('t2', 'config', at(2), {
        kind: 'config',
        bucket: 'demo',
        providerId: 'p1',
        findings: [
          {
            severity: 'high',
            title: 'Bucket is publicly accessible',
            detail: 'The policy lets anyone read objects',
            code: 'public_exposure',
          },
        ],
        observations: [{ provider: 'p1', bucket: 'demo', code: 'public_exposure', verdict: true }],
      }),
    ])
    expect(brief.findings).toHaveLength(1)
    expect(brief.findings[0]).toMatchObject({
      issueId: 'x',
      detail: 'The policy lets anyone read objects',
      provider: 'p1',
    })
  })

  it('marks memory and fresh reads apart', () => {
    const brief = buildBrief([
      user('u1', at(0)),
      tool('t1', 'estate', at(1), {
        kind: 'estate',
        providerId: 'p1',
        buckets: null,
        issues: [issue('a', 'medium', 'old')],
        notes: [],
      }),
    ])
    expect(brief.findings[0]?.source).toBe('memory')
  })

  it('folds an Issue the user accepted and drops one resolved elsewhere', () => {
    const entries: UiEntry[] = [
      user('u1', at(0)),
      tool(
        't1',
        'survey',
        at(1),
        survey([issue('a', 'high', 'demo'), issue('b', 'medium', 'prod')]),
      ),
    ]
    const brief = buildBrief(entries, null, { a: 'accepted', b: 'resolved' })
    expect(brief.findings).toHaveLength(0)
    expect(brief.accepted.map((finding) => finding.key)).toEqual(['issue:a'])
    expect(brief.resolved.map((finding) => finding.key)).toEqual(['issue:b'])
  })

  it('keeps coverage per account, with the buckets a stopped survey did not read', () => {
    const brief = buildBrief([
      user('u1', at(0)),
      tool('t1', 'survey', at(1), survey([], { denied: ['secret'], pending: 4 })),
    ])
    expect(brief.coverage).toHaveLength(1)
    expect(brief.coverage[0]).toMatchObject({ denied: ['secret'], pending: 4 })
  })

  it('shows a review blind spot until a later reading of that bucket', () => {
    const blindReview: ToolView = {
      kind: 'config',
      bucket: 'demo',
      findings: [
        { severity: 'blind', title: 'Access denied reading CORS', detail: '', code: 'blind:CORS' },
      ],
    }
    expect(buildBrief([tool('t1', 'config', at(1), blindReview)]).blind).toHaveLength(1)
    expect(
      buildBrief([
        tool('t1', 'config', at(1), blindReview),
        tool('t2', 'survey', at(2), survey([])),
      ]).blind,
    ).toHaveLength(0)
  })

  it('measures only the current turn', () => {
    const brief = buildBrief([
      tool('t0', 'buckets', at(0), { kind: 'buckets', rows: { columns: ['B'], rows: [] } }, 9000),
      user('u1', at(10)),
      tool('t1', 'config', at(11), { kind: 'config', bucket: 'demo', findings: [] }, 400),
      tool('t2', 'survey', at(12), survey([]), 600),
      answer('a1', at(13), 'Clean.'),
    ])
    expect(brief.durationMs).toBe(1000)
    expect(brief.data?.sourceId).toBe('t2')
  })

  it('puts a streaming verdict above the last settled one', () => {
    const brief = buildBrief([user('u1', at(0)), answer('a1', at(1), 'Old answer.')], {
      tools: [{ callId: 'c1', name: 'survey', target: 'acme', note: '3 of 12', startedAt: at(2) }],
      text: 'New answer',
      startedAt: at(2),
    })
    expect(brief.verdict).toMatchObject({ text: 'New answer', streaming: true })
    expect(brief.checks.at(-1)).toMatchObject({ status: 'running', note: '3 of 12' })
  })

  it('marks a verdict that names a bucket no tool returned', () => {
    const brief = buildBrief([
      user('u1', at(0)),
      tool('t1', 'survey', at(1), survey([issue('a', 'high', 'demo')])),
      answer('a1', at(2), '`demo` is public and `imaginary` is too.'),
    ])
    expect(brief.verdict?.ungrounded).toEqual(['imaginary'])
  })

  it('marks a verdict that answers an earlier question as stale', () => {
    const brief = buildBrief([
      user('u1', at(0)),
      answer('a1', at(1), 'First.'),
      user('u2', at(2), 'and now?'),
    ])
    expect(brief.verdict).toMatchObject({ text: 'First.', stale: true })
  })

  it('clears an old notice once the user continues', () => {
    const brief = buildBrief([
      user('u1', at(0)),
      {
        id: 'n1',
        kind: 'notice',
        at: '',
        code: 'stopped',
        text: '',
        tone: 'info',
        action: 'continue',
      },
      { id: 'r1', kind: 'resume', at: at(2) },
    ])
    expect(brief.notices).toHaveLength(0)
    expect(brief.questions).toHaveLength(1)
  })

  it('keeps the latest fix per bucket and rule, newest first', () => {
    const brief = buildBrief([
      tool('t1', 'fix', at(1), fix('demo', 'no_default_encryption')),
      tool('t2', 'fix', at(2), fix('prod', 'public_access_block_missing')),
      tool('t3', 'fix', at(3), fix('demo', 'no_default_encryption')),
    ])
    expect(brief.fixes.map((item) => item.sourceId)).toEqual(['t3', 't2'])
  })

  it('ignores a check that did not finish', () => {
    const brief = buildBrief([
      tool('t1', 'survey', at(1), null, 10, 'timeout'),
      tool('t2', 'survey', at(2), null, 10, 'stopped'),
    ])
    expect(brief.data).toBeNull()
    expect(brief.checks.map((check) => check.status)).toEqual(['timeout', 'stopped'])
  })
})
