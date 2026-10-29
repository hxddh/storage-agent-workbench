import { describe, expect, it } from 'vitest'
import { mapEntries } from './project'

const entries = (value: unknown[]) => mapEntries(value as never)

describe('entry projection', () => {
  it('keeps the request text and its attachments', () => {
    const out = entries([
      {
        id: 'e1',
        kind: 'sa.run',
        data: {
          trigger: 'user',
          text: 'Which buckets are public?',
          attachments: [{ name: 'log.csv', bytes: 12 }],
        },
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'user',
      text: 'Which buckets are public?',
      attachments: [{ name: 'log.csv', bytes: 12 }],
    })
  })

  it('projects assistant text and ignores tool-call-only turns', () => {
    const out = entries([
      {
        id: 'e2',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'demo-public is public.' }],
            timestamp: 1_700_000_000_000,
          },
        ],
      },
      {
        id: 'e3',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call-1', name: 'survey', arguments: {} }],
            timestamp: 1_700_000_000_001,
          },
        ],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'answer', text: 'demo-public is public.' })
  })

  it('keeps a provider reasoning summary separate from the answer', () => {
    const out = entries([
      {
        id: 'e2b',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Check the policy before answering.' },
              { type: 'text', text: 'demo-public is public.' },
            ],
            timestamp: 1_700_000_000_000,
          },
        ],
      },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      kind: 'reasoning',
      text: 'Check the policy before answering.',
    })
    expect(out[1]).toMatchObject({ kind: 'answer', text: 'demo-public is public.' })
  })

  it('turns a tool result into one row with its view', () => {
    const out = entries([
      {
        id: 'e4',
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'survey',
            content: [{ type: 'text', text: 'ok' }],
            details: {
              target: 'Demo',
              note: '2 buckets',
              args: '{"provider_id":"p1"}',
              view: { kind: 'buckets', rows: { columns: ['Bucket'], rows: [['a']] } },
              ms: 12,
            },
            isError: false,
            timestamp: 1_700_000_000_002,
          },
        ],
      },
    ])
    expect(out[0]).toMatchObject({
      kind: 'tool',
      name: 'survey',
      target: 'Demo',
      status: 'done',
      args: '{"provider_id":"p1"}',
      ms: 12,
    })
    if (out[0]?.kind !== 'tool') throw new Error('expected a tool entry')
    expect(out[0].view?.kind).toBe('buckets')
  })

  it('marks a tool error and keeps its note', () => {
    const out = entries([
      {
        id: 'e5',
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call-2',
            toolName: 'config',
            content: [{ type: 'text', text: 'Access denied' }],
            details: { target: 'demo', note: 'Access denied', view: null, ms: 3 },
            isError: true,
            timestamp: 1,
          },
        ],
      },
    ])
    expect(out[0]).toMatchObject({ kind: 'tool', status: 'failed', note: 'Access denied' })
  })

  it('renders notices and compaction dividers', () => {
    const out = entries([
      { id: 'e6', kind: 'sa.notice', data: { text: 'The run failed.', tone: 'error' } },
      { id: 'e7', kind: 'pi.compaction' },
    ])
    expect(out[0]).toMatchObject({ kind: 'notice', tone: 'error' })
    expect(out[1]).toMatchObject({ kind: 'compaction' })
  })

  it('takes status from details, never from result text', () => {
    const out = entries([
      {
        id: 'e8',
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call-3',
            toolName: 'survey',
            content: [{ type: 'text', text: 'Public: aborted-uploads, timed-out-logs.' }],
            details: { target: 'Demo', note: null, view: null, ms: 5, status: 'done' },
            isError: false,
            timestamp: 1,
          },
        ],
      },
      {
        id: 'e9',
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call-4',
            toolName: 'config',
            content: [{ type: 'text', text: 'Timed out' }],
            details: {
              target: 'demo',
              note: 'Timed out',
              view: null,
              ms: 90_000,
              status: 'timeout',
            },
            isError: true,
            timestamp: 2,
          },
        ],
      },
    ])
    expect(out.map((entry) => (entry.kind === 'tool' ? entry.status : null))).toEqual([
      'done',
      'timeout',
    ])
  })

  it('reads a 35.0 scripted check as ordinary calls and an answer', () => {
    const out = entries([
      { id: 'run1', kind: 'sa.run', data: { trigger: 'check', at: '2026-10-24T12:00:00.000Z' } },
      {
        id: 'call1',
        kind: 'sa.call',
        data: {
          name: 'survey',
          at: '2026-10-24T12:00:00.000Z',
          details: {
            target: 'Demo',
            note: '1 bucket',
            ms: 4,
            status: 'done',
            evidenceId: 'chk_1',
            key: 'k1',
            view: { kind: 'buckets', rows: { columns: ['Bucket'], rows: [['demo']] } },
          },
        },
      },
      {
        id: 'ans1',
        kind: 'sa.answer',
        data: {
          text: '1 risk is open across 1 bucket, including `demo`.',
          at: '2026-10-24T12:00:01.000Z',
        },
      },
    ])
    expect(out.map((entry) => entry.kind)).toEqual(['tool', 'answer'])
    expect(out[0]).toMatchObject({
      name: 'survey',
      target: 'Demo',
      evidenceId: 'chk_1',
    })
    expect(out[1]).toMatchObject({ text: '1 risk is open across 1 bucket, including `demo`.' })
  })

  it('keeps a steer apart from a request', () => {
    const out = entries([
      {
        id: 's1',
        kind: 'sa.steer',
        data: { text: 'Only the finance account', attachments: [] },
        model: [{ role: 'user', content: 'Only the finance account', timestamp: 2 }],
      },
    ])
    expect(out[0]).toMatchObject({ kind: 'steer', text: 'Only the finance account' })
  })

  it('does not show the harness messages to the model, and shows a resume', () => {
    const out = entries([
      { id: 'e10', kind: 'pi.user', model: [{ role: 'user', content: 'Rewrite the verdict' }] },
      {
        id: 'e11',
        kind: 'sa.resume',
        model: [{ role: 'user', content: 'Continue', timestamp: 3 }],
      },
    ])
    expect(out).toEqual([{ id: 'e11', kind: 'resume', at: new Date(3).toISOString() }])
  })

  it('drops a tool result for a tool this app does not have', () => {
    const out = entries([
      {
        id: 'e12',
        kind: 'pi.tool-result',
        model: [
          { role: 'toolResult', toolCallId: 'x', toolName: 'shell', content: [], timestamp: 1 },
        ],
      },
    ])
    expect(out).toHaveLength(0)
  })

  it('keeps a call the harness blocked, as a step that did not run', () => {
    const out = entries([
      {
        id: 'e13',
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'x',
            toolName: 'survey',
            isError: true,
            content: [
              {
                type: 'text',
                text: 'This turn has made 100 rounds of tool calls; this call did not run.',
              },
            ],
            timestamp: 1,
          },
        ],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'tool',
      status: 'failed',
      note: 'Did not run',
      output: 'This turn has made 100 rounds of tool calls; this call did not run.',
    })
  })
})
