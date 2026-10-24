import { briefSearchText, buildBrief } from '@shared/brief'
import type { IssueRow, ToolView, UiEntry } from '@shared/contract'
import { describe, expect, it } from 'vitest'

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString()

const issue = (id: string, severity: 'high' | 'medium' | 'low', bucket: string): IssueRow => ({
  id,
  provider: 'acme',
  bucket,
  code: `code-${id}`,
  severity,
  status: 'open',
  title: `Issue ${id}`,
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
): UiEntry => ({
  id,
  kind: 'tool',
  at: time,
  name,
  target: 'acme',
  status: 'done',
  note: null,
  ms,
  view,
})

const survey = (issues: IssueRow[], denied: string[] = []): ToolView => ({
  kind: 'survey',
  provider: 'acme',
  buckets: { columns: ['Bucket'], rows: [['demo']] },
  issues,
  coverage: { visible: 3, processed: 3, truncated: false, denied, unknown: [] },
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

describe('brief projection', () => {
  it('merges the same issue seen by two tools and orders by severity', () => {
    const entries: UiEntry[] = [
      user('u1', at(0)),
      tool(
        't1',
        'survey',
        at(1),
        survey([issue('a', 'medium', 'demo'), issue('b', 'high', 'prod')]),
      ),
      tool('t2', 'estate', at(2), {
        kind: 'estate',
        buckets: null,
        issues: [issue('b', 'high', 'prod'), issue('c', 'low', 'logs')],
        notes: [],
      }),
      answer('a1', at(3), 'Two buckets need attention.'),
    ]
    const brief = buildBrief(entries)
    expect(brief.findings.map((finding) => finding.key)).toEqual(['issue:b', 'issue:a', 'issue:c'])
    expect(brief.findings).toHaveLength(3)
    const docs = briefSearchText(brief).filter((doc) => doc.kind === 'finding')
    expect(docs).toHaveLength(3)
    expect(new Set(docs.map((doc) => doc.entryId)).size).toBe(3)
    expect(brief.verdict).toMatchObject({ text: 'Two buckets need attention.', streaming: false })
    expect(brief.questions).toHaveLength(1)
  })

  it('collapses the review finding that produced an issue into that issue', () => {
    const exposed = { ...issue('x', 'high', 'demo'), code: 'public_exposure' }
    const entries: UiEntry[] = [
      user('u1', at(0)),
      tool('t1', 'survey', at(1), survey([exposed])),
      tool('t2', 'config', at(2), {
        kind: 'config',
        bucket: 'demo',
        findings: [
          {
            severity: 'high',
            title: 'Bucket policy makes this bucket PUBLIC (AWS verdict)',
            detail: 'GetBucketPolicyStatus reports public access.',
            code: 'public_exposure',
          },
        ],
      }),
    ]
    const brief = buildBrief(entries)
    expect(brief.findings).toHaveLength(1)
    const docs = briefSearchText(brief).filter((doc) => doc.kind === 'finding')
    expect(new Set(docs.map((doc) => doc.entryId)).size).toBe(docs.length)
    expect(brief.findings[0]).toMatchObject({
      title: 'Issue x',
      detail: 'GetBucketPolicyStatus reports public access.',
      sourceId: 't1',
      provider: 'acme',
    })
  })

  it('keeps coverage blind spots even when no finding was raised', () => {
    const entries: UiEntry[] = [
      user('u1', at(0)),
      tool('t1', 'survey', at(1), survey([], ['secret-bucket'])),
      answer('a1', at(2), 'Nothing readable was wrong.'),
    ]
    const brief = buildBrief(entries)
    expect(brief.findings).toHaveLength(0)
    expect(brief.coverage?.denied).toEqual(['secret-bucket'])
  })

  it('measures only the current turn', () => {
    const entries: UiEntry[] = [
      tool('t0', 'buckets', at(0), { kind: 'buckets', rows: { columns: ['B'], rows: [] } }, 9000),
      user('u1', at(10)),
      tool(
        't1',
        'config',
        at(11),
        {
          kind: 'config',
          bucket: 'demo',
          findings: [{ severity: 'ok', title: 'fine', detail: '' }],
        },
        400,
      ),
      tool('t2', 'survey', at(12), survey([]), 600),
      answer('a1', at(13), 'Clean.'),
    ]
    const brief = buildBrief(entries)
    expect(brief.durationMs).toBe(1000)
    expect(brief.findings).toHaveLength(0)
    expect(brief.data?.sourceId).toBe('t2')
  })

  it('puts a streaming verdict above the last settled one', () => {
    const entries: UiEntry[] = [user('u1', at(0)), answer('a1', at(1), 'Old answer.')]
    const brief = buildBrief(entries, {
      tools: [{ callId: 'c1', name: 'survey', target: 'acme', note: '3 of 12', startedAt: at(2) }],
      text: 'New answer',
      startedAt: at(2),
    })
    expect(brief.verdict).toMatchObject({ text: 'New answer', streaming: true })
    expect(brief.checks.at(-1)).toMatchObject({ status: 'running', note: '3 of 12' })
  })

  it('extracts a fix and indexes findings for search', () => {
    const entries: UiEntry[] = [
      user('u1', at(0)),
      tool('t1', 'config', at(1), {
        kind: 'config',
        bucket: 'demo',
        findings: [
          { severity: 'high', title: 'Anonymous read', detail: 'policy allows *' },
          { severity: 'ok', title: 'Encrypted', detail: '' },
        ],
      }),
      tool('t2', 'fix', at(2), {
        kind: 'fix',
        bucket: 'demo',
        code: 'aws s3api ...',
        formats: [{ label: 'AWS CLI', language: 'bash', text: 'aws s3api ...' }],
        impact: { verdict: 'caution', reasons: ['reads break'], gap: null },
      }),
    ]
    const brief = buildBrief(entries)
    expect(brief.findings.map((finding) => finding.title)).toEqual(['Anonymous read'])
    expect(brief.fix?.view.bucket).toBe('demo')
    expect(brief.data).toBeNull()
    const findingDocs = briefSearchText(brief).filter((doc) => doc.kind === 'finding')
    expect(findingDocs).toHaveLength(1)
    expect(findingDocs[0]?.entryId).toMatch(/^f:/)
  })
})
