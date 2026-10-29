import { describe, expect, it } from 'vitest'
import { foldLedger } from './ledger'
import { request, survey, tool } from './testing'
import { checkAnswer, citationIds, correctionFor } from './validate'

const ledger = foldLedger([
  request(),
  tool('survey', survey(['demo-public', 'demo-private']), { id: 'ev1' }),
  tool(
    'config',
    { kind: 'config', bucket: 'demo-public', providerId: 'p1', aspect: 'security', findings: [] },
    { id: 'ev2', target: 'demo-public' },
  ),
])

describe('answer validation', () => {
  it('passes cited, grounded prose in any language', () => {
    expect(checkAnswer('`demo-public` 是公开的。[1](#ev-ev2)', ledger)).toEqual({
      ungrounded: [],
      unresolved: [],
      uncited: [],
    })
  })

  it('finds a citation that does not resolve to this run', () => {
    expect(checkAnswer('`demo-public` is public [1](#ev-nope).', ledger).unresolved).toEqual([
      'nope',
    ])
  })

  it('asks a paragraph that names a read bucket to cite a result that shows it', () => {
    const result = checkAnswer(
      '`demo-private` is private [1](#ev-ev2).\n\n## `demo-public`\n\n`demo-public` is public [2](#ev-ev1).',
      ledger,
    )
    // ev2 (a review of demo-public) does not show demo-private; ev1 shows demo-public.
    expect(result.uncited).toEqual(['demo-private'])
  })

  it('does not ask for a citation for a name the run did not read', () => {
    expect(checkAnswer('Some `notes.txt` mention it.', foldLedger([request()])).uncited).toEqual([])
  })

  it('reads citations whatever the label', () => {
    expect(citationIds('see [the survey](#ev-a%3A1) and [2](#ev-b)')).toEqual(['a:1', 'b'])
  })

  it('words one correction for everything that failed', () => {
    const text = correctionFor({ ungrounded: ['ghost'], unresolved: ['x'], uncited: ['demo'] })
    expect(text).toMatch(/`ghost`, which no tool result in this task shows/)
    expect(text).toMatch(/#ev-x/)
    expect(text).toMatch(/`demo` without citing/)
    expect(correctionFor({ ungrounded: [], unresolved: [], uncited: [] })).toBeUndefined()
  })
})
