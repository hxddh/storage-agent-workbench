import { buildActivity } from '@shared/activity'
import type { Live, UiEntry } from '@shared/contract'
import { describe, expect, it } from 'vitest'

const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`

const user = (id: string, minute: number): UiEntry => ({
  id,
  kind: 'user',
  at: at(minute),
  text: 'Check it',
  attachments: [],
})

const tool = (
  id: string,
  minute: number,
  callId: string,
  status: 'done' | 'failed' = 'done',
): UiEntry => ({
  id,
  kind: 'tool',
  at: at(minute),
  name: 'survey',
  target: 'Demo',
  status,
  note: '2 buckets',
  ms: 1200,
  callId,
  view: null,
})

const live = (tools: Live['tools'], reasoning: Live['reasoning'] = null): Live => ({
  phase: 'tool',
  tools,
  reasoning,
  text: null,
  startedAt: at(1),
})

describe('activity projection', () => {
  it('keeps the current turn and merges live calls by call id', () => {
    const activity = buildActivity(
      [
        user('u0', 0),
        tool('old', 0, 'old-call'),
        user('u1', 1),
        tool('t1', 2, 'call-1'),
        tool('t2', 3, 'call-2', 'failed'),
      ],
      live([
        {
          callId: 'call-1',
          name: 'survey',
          target: 'Demo',
          note: '3 of 4',
          status: 'done',
          startedAt: at(2),
        },
        {
          callId: 'call-3',
          name: 'config',
          target: 'demo-public',
          note: null,
          status: 'running',
          startedAt: at(4),
        },
      ]),
    )
    expect(activity.items.map((item) => item.kind)).toEqual(['tool', 'tool', 'tool'])
    expect(activity.items.filter((item) => item.kind === 'tool').map((item) => item.id)).toEqual([
      'call-1',
      'call-2',
      'live:call-3:2026-01-01T00:04:00.000Z',
    ])
    expect(activity.calls).toBe(3)
    expect(activity.running).toBe(1)
    expect(activity.durationMs).toBe(2400)
  })

  it('keeps reasoning, skips the plan, and shows a method without counting it as a call', () => {
    const activity = buildActivity([
      user('u1', 0),
      { id: 'r1', kind: 'reasoning', at: at(1), text: 'Check the policy first.' },
      {
        id: 'p1',
        kind: 'tool',
        at: at(1),
        name: 'plan',
        target: 'investigation',
        status: 'done',
        note: null,
        ms: 0,
        view: { kind: 'plan', steps: [] },
      },
      {
        id: 's1',
        kind: 'tool',
        at: at(1),
        name: 'skill',
        target: 'access',
        status: 'done',
        note: null,
        ms: 0,
        view: {
          kind: 'skill',
          name: 'access',
          title: 'Access',
          description: 'Read access',
          body: '',
        },
      },
    ])
    expect(activity.items).toHaveLength(2)
    expect(activity.items[0]).toMatchObject({ kind: 'reasoning', text: 'Check the policy first.' })
    expect(activity.items[1]).toMatchObject({ kind: 'tool', name: 'skill' })
    expect(activity.calls).toBe(0)
  })

  it('adds a live reasoning row while the model is thinking', () => {
    const activity = buildActivity([user('u1', 0)], {
      phase: 'reasoning',
      tools: [],
      reasoning: { summary: 'Look at the account block.', startedAt: at(1) },
      text: null,
      startedAt: at(1),
    })
    expect(activity.items[0]).toMatchObject({
      kind: 'reasoning',
      text: 'Look at the account block.',
      live: true,
    })
  })

  it('records a resume as a quiet boundary in the current turn', () => {
    const activity = buildActivity([
      user('u1', 0),
      { id: 'resume', kind: 'resume', at: at(1) },
      tool('t1', 2, 'call-1'),
    ])
    expect(activity.items[0]).toMatchObject({ kind: 'resume', id: 'resume' })
    expect(activity.calls).toBe(1)
  })
})
