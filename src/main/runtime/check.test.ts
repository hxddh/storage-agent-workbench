import { foldLedger } from '@shared/ledger'
import { issue, request, survey, tool } from '@shared/testing'
import { checkAnswer as validate } from '@shared/validate'
import { describe, expect, it } from 'vitest'
import { accessTargets, checkAnswer, recheckAnswer, recheckTargets } from './check'

describe('the scripted check answer', () => {
  it('never closes the question when a read was incomplete', () => {
    const text = checkAnswer(
      [{ view: survey(['a', 'b'], { coverage: { denied: ['b'] } }), evidenceId: 'e1' }],
      { examined: 2, total: 2 },
      0,
      'en',
    )
    expect(text).toMatch(/cannot close the question/)
    expect(text).toMatch(/1 bucket could not be read completely/)
    expect(text).not.toMatch(/No open risk/)
  })

  it('names counts and buckets it read, and cites the survey that showed them', () => {
    const view = survey(['a', 'b'], { issues: [issue('a'), issue('b', 'no_encryption')] })
    const text = checkAnswer([{ view, evidenceId: 'e1' }], { examined: 2, total: 2 }, 0, 'en')
    expect(text).toMatch(/2 risks \(1 high\) are open across 2 buckets, including `a`, `b`/)
    // It passes the same validation a model's answer does.
    const ledger = foldLedger([request(), tool('survey', view, { id: 'e1' })])
    expect(validate(text, ledger)).toEqual({ ungrounded: [], unresolved: [], uncited: [] })
  })

  it('does not call an account clean when the survey cap left buckets unread', () => {
    const text = checkAnswer(
      [{ view: survey(['a'], { coverage: { visible: 6, truncated: true } }) }],
      { examined: 1, total: 6 },
      0,
      'en',
    )
    expect(text).toMatch(/5 buckets were outside this run/)
    expect(text).toMatch(/Access paths covered 1 of 6 buckets/)
  })

  it('says when an account could not be read at all', () => {
    expect(checkAnswer([], { examined: 0, total: 0 }, 1, 'en')).toMatch(/could not read any/)
    expect(checkAnswer([{ view: survey(['a']) }], { examined: 1, total: 1 }, 1, 'zh')).toMatch(
      /1 个账号未能读取/,
    )
  })
})

describe('what a check and a re-check read', () => {
  it('examines access for risky buckets first, up to 24', () => {
    const names = Array.from({ length: 30 }, (_, index) => `b${index}`)
    const targets = accessTargets(survey(names, { issues: [issue('b29')] }))
    expect(targets[0]).toBe('b29')
    expect(targets).toHaveLength(24)
  })

  it('replays every bucket the task read, by account and aspect, and the change plan', () => {
    const targets = recheckTargets([
      request(),
      tool('survey', survey(['a'])),
      tool('config', {
        kind: 'config',
        bucket: 'b',
        providerId: 'p1',
        aspect: 'access',
        findings: [],
      }),
      tool('config', null, { status: 'failed', target: 'c' }),
    ])
    const buckets = targets.accounts.get('p1')!
    expect([...buckets.keys()].sort()).toEqual(['a', 'b'])
    expect([...buckets.get('a')!]).toEqual(['security', 'lifecycle'])
    expect([...buckets.get('b')!]).toEqual(['access'])
  })

  it('writes the re-check answer from its report', () => {
    const text = recheckAnswer(
      {
        at: '',
        checked: 2,
        skipped: 0,
        changes: [{ bucket: 'a', code: 'x', title: 'X', before: 'open', after: 'clear' }],
        opened: 0,
        resolved: 1,
        undecided: 0,
        plan: { steps: [], confirmed: 0, notApplied: 1, unknown: 0 },
      },
      'e1',
      'en',
    )
    expect(text).toMatch(/Re-read 2 buckets/)
    expect(text).toMatch(/1 conclusion changed: 0 opened, 1 resolved/)
    expect(text).toMatch(/1 not applied/)
    expect(text).toContain('(#ev-e1)')
  })
})
