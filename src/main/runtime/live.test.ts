import type { ConversationView } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { LiveTracker } from './project'

function view(live: unknown): ConversationView {
  return { docs: { 'pi.live': live } } as unknown as ConversationView
}

describe('live projection', () => {
  it('keeps completed calls and uses shaped progress, not raw output', () => {
    const tracker = new LiveTracker()
    const state = tracker.map(
      view({
        run: true,
        tools: [
          {
            callId: 'call-1',
            name: 'survey',
            status: 'running',
            output: 'RAW_TOOL_OUTPUT_SHOULD_NOT_REACH_THE_WINDOW',
            details: { target: 'Demo', progress: '3 of 4 buckets', status: 'running' },
          },
          {
            callId: 'call-2',
            name: 'config',
            status: 'done',
            details: { target: 'demo-public', note: '4 findings', status: 'done' },
          },
        ],
      }),
      'task',
    )
    expect(state?.tools).toEqual([
      {
        callId: 'call-1',
        name: 'survey',
        target: 'Demo',
        note: '3 of 4 buckets',
        status: 'running',
        startedAt: expect.any(String),
      },
      {
        callId: 'call-2',
        name: 'config',
        target: 'demo-public',
        note: '4 findings',
        status: 'done',
        startedAt: expect.any(String),
      },
    ])
    expect(state?.phase).toBe('tool')
  })

  it('projects a provider reasoning summary separately', () => {
    const tracker = new LiveTracker()
    const state = tracker.map(
      view({
        run: true,
        tools: [],
        generation: {
          message: {
            content: [{ type: 'thinking', thinking: 'Check the public access block.' }],
          },
        },
      }),
      'task-reasoning',
    )
    expect(state?.phase).toBe('reasoning')
    expect(state?.reasoning).toMatchObject({
      summary: 'Check the public access block.',
      startedAt: expect.any(String),
    })
  })

  it('marks a failed tool instead of calling it running', () => {
    const tracker = new LiveTracker()
    const state = tracker.map(
      view({
        run: true,
        tools: [
          {
            callId: 'call-3',
            name: 'config',
            status: 'error',
            details: { target: 'demo-public', note: 'Access denied', status: 'failed' },
          },
        ],
      }),
      'task-failed',
    )
    expect(state?.tools[0]).toMatchObject({ status: 'failed', note: 'Access denied' })
  })
})
