import { describe, expect, it } from 'vitest'
import type { Live, UiEntry } from './contract'
import {
  callFor,
  pendingQuestion,
  supersededPlans,
  thread,
  transcriptMarkdown,
} from './conversation'
import { answer, request, survey, tool } from './testing'

describe('the conversation thread', () => {
  it('keeps every message, step and text in the order it happened, across turns', () => {
    const entries: UiEntry[] = [
      request('Which buckets are public?'),
      { id: 'r1', kind: 'reasoning', at: '', text: 'Read the account first.' },
      tool('survey', survey(['a']), { id: 's1' }),
      answer('`a` is private.'),
      request('And the access paths?'),
      tool('config', null, { id: 'c1', status: 'failed', target: 'a' }),
      answer('I could not read them.'),
    ]
    expect(thread(entries).map((item) => item.kind)).toEqual([
      'user',
      'thought',
      'tool',
      'text',
      'user',
      'tool',
      'text',
    ])
  })

  it('shows a steer as the user speaking, inside the running turn', () => {
    const items = thread([
      request(),
      { id: 's', kind: 'steer', at: '', text: 'Only demo', attachments: [] },
    ])
    expect(items[1]).toMatchObject({ kind: 'user', steer: true, text: 'Only demo' })
  })

  it('appends the live slot: running calls, a reasoning summary and streaming text', () => {
    const live: Live = {
      phase: 'writing',
      tools: [
        {
          callId: 'x',
          name: 'config',
          target: 'a',
          note: '2 of 5',
          status: 'running',
          startedAt: '2026-01-01T00:00:00Z',
        },
      ],
      reasoning: { summary: 'Check the policy.', startedAt: '2026-01-01T00:00:00Z' },
      text: 'Partly',
      startedAt: '2026-01-01T00:00:00Z',
    }
    const items = thread([request()], live)
    expect(items.map((item) => item.kind)).toEqual(['user', 'thought', 'tool', 'text'])
    expect(items.at(-1)).toMatchObject({ streaming: true, text: 'Partly' })
    expect(items[2]).toMatchObject({ status: 'running', entryId: null })
  })

  it('does not show a live call twice once its result is durable', () => {
    const live: Live = {
      phase: 'tool',
      tools: [
        { callId: 's1', name: 'survey', target: '', note: null, status: 'done', startedAt: '' },
      ],
      reasoning: null,
      text: null,
      startedAt: '',
    }
    const items = thread([request(), tool('survey', survey(['a']), { id: 's1' })], live)
    expect(items.filter((item) => item.kind === 'tool')).toHaveLength(1)
  })

  it('links a citation to its call, and knows when the agent is waiting on a question', () => {
    const items = thread([
      request(),
      tool('survey', survey(['a']), { id: 's1' }),
      tool(
        'ask',
        { kind: 'question', question: 'Which account?', options: ['A', 'B'] },
        { id: 'q1' },
      ),
    ])
    expect(callFor(items, 's1')).toMatchObject({ name: 'survey' })
    expect(pendingQuestion(items)).toBe('q1')
    expect(pendingQuestion([...items, ...thread([request('A')])])).toBeNull()
  })

  it('keeps every plan call, and knows which ones a later update in the turn replaced', () => {
    const plan = (id: string, note: string) =>
      tool('plan', { kind: 'plan', steps: [], note }, { id })
    const items = thread([
      request('A'),
      plan('p1', 'first'),
      plan('p2', 'second'),
      request('B'),
      plan('p3', 'third'),
    ])
    expect(items.filter((item) => item.kind === 'tool')).toHaveLength(3)
    expect([...supersededPlans(items)]).toEqual(['p1'])
  })

  it('saves the conversation as Markdown', () => {
    const text = transcriptMarkdown(
      thread([request('Q?'), tool('survey', survey(['a']), { target: 'Demo' }), answer('A.')]),
    )
    expect(text).toBe('**You:** Q?\n\n> survey · Demo · done\n\nA.')
  })
})
