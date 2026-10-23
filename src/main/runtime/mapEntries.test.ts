import { describe, expect, it } from 'vitest'
import { mapEntries } from './harness'

const entries = (value: unknown[]) => mapEntries(value as never)

describe('entry projection', () => {
  it('keeps the request text and its attachments', () => {
    const out = entries([
      {
        id: 'e1',
        kind: 'sa.user',
        data: { text: 'Which buckets are public?', attachments: [{ name: 'log.csv', bytes: 12 }] },
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
})
