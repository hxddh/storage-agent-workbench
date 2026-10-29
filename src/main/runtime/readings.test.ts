import type { UiEntry } from '@shared/contract'
import { request, survey, tool } from '@shared/testing'
import { describe, expect, it } from 'vitest'
import { turnStart, turnSurveys } from './readings'

describe('reading records', () => {
  it('starts a turn at the latest user message, never at a steer', () => {
    const entries: UiEntry[] = [
      request('first'),
      tool('survey', survey(['a'])),
      request('second'),
      { id: 's', kind: 'steer', at: '', text: 'narrow it', attachments: [] },
    ]
    expect(turnStart(entries)).toBe(2)
  })

  it('records the counts of the turn’s account survey, and no verdict', () => {
    const [counts] = turnSurveys([
      request(),
      tool(
        'survey',
        survey(['a', 'b', 'c'], {
          coverage: { visible: 10, processed: 3, pending: 2, truncated: true, denied: ['secret'] },
        }),
      ),
    ])
    expect(counts).toMatchObject({ visible: 10, processed: 3, pending: 2, truncated: 5, denied: 1 })
    expect(counts).not.toHaveProperty('complete')
  })

  it('never lets a narrowed re-read stand in for the account', () => {
    expect(turnSurveys([request(), tool('survey', survey(['a'], { scoped: true }))])).toEqual([])
    const [merged] = turnSurveys([
      request(),
      tool('survey', survey(['a', 'b'], { coverage: { visible: 3, denied: ['b'] } })),
      tool('survey', survey(['b'], { scoped: true })),
    ])
    expect(merged?.denied).toBe(0)
  })

  it('belongs to the current turn only', () => {
    expect(turnSurveys([request(), tool('survey', survey(['a'])), request('again')])).toEqual([])
  })
})
