import type { ToolView } from '@shared/contract'
import { describe, expect, it } from 'vitest'
import {
  type AgentState,
  blockReason,
  coverageCorrection,
  freshRun,
  groundingCorrection,
  MAX_TOOL_ROUNDS,
  maxRounds,
  readGapTotals,
  recordReadGaps,
  reportTextOf,
  tierFor,
} from './agent'

function state(known: string[] = []): AgentState {
  return { digest: '', language: 'en', tier: 'mid', runs: new Map([['c', freshRun(known)]]) }
}

describe('model tiers', () => {
  it('includes markdown prose in the grounding candidate', () => {
    expect(
      reportTextOf([
        { kind: 'summary', text: 'The summary.', evidence: [] },
        { kind: 'markdown', text: '## Detail\n\nThe markdown.', evidence: [] },
      ]),
    ).toContain('The markdown.')
  })

  it('gives a small context model fewer rounds', () => {
    expect(tierFor(32_000)).toBe('small')
    expect(tierFor(128_000)).toBe('mid')
    expect(tierFor(400_000)).toBe('large')
    expect(maxRounds('small')).toBeLessThan(MAX_TOOL_ROUNDS)
    expect(maxRounds('large')).toBeGreaterThan(MAX_TOOL_ROUNDS)
  })
})

describe('run guardrails', () => {
  it('blocks a repeated storage read, whatever the key order', () => {
    const s = state()
    expect(blockReason(s, 'c', 'config', { bucket: 'a', aspect: 'security' })).toBeUndefined()
    expect(blockReason(s, 'c', 'config', { aspect: 'security', bucket: 'a' })).toMatch(
      /already ran/,
    )
    expect(blockReason(s, 'c', 'config', { bucket: 'a', aspect: 'lifecycle' })).toBeUndefined()
  })

  it('lets memory be read again as it changes', () => {
    const s = state()
    expect(blockReason(s, 'c', 'estate', {})).toBeUndefined()
    expect(blockReason(s, 'c', 'estate', {})).toBeUndefined()
  })

  it('stops every tool at the round cap', () => {
    const s = state()
    s.runs.get('c')!.rounds = MAX_TOOL_ROUNDS
    expect(blockReason(s, 'c', 'estate', {})).toMatch(/Step budget/)
  })

  it('asks once for a grounded verdict, then lets the window mark it', () => {
    const s = state(['demo'])
    expect(groundingCorrection(s, 'c', '`demo` is public.')).toBeUndefined()
    expect(groundingCorrection(s, 'c', '`demo` and `ghost` are public.')).toMatch(/`ghost`/)
    expect(groundingCorrection(s, 'c', '`ghost` again.')).toBeUndefined()
  })

  it('does not judge a verdict when the task has read nothing it remembers', () => {
    expect(groundingCorrection(state(), 'c', '`anything`')).toBeUndefined()
  })
})

describe('read closure', () => {
  const surveyView = (overrides: Record<string, unknown> = {}) =>
    ({
      kind: 'survey',
      provider: 'Demo',
      providerId: 'p',
      buckets: { columns: [], rows: [] },
      issues: [],
      coverage: {
        visible: 10,
        processed: 6,
        truncated: true,
        pending: 2,
        denied: ['secret'],
        unknown: [],
      },
      changed: { opened: 0, resolved: 0, recurred: 0 },
      ...overrides,
    }) as ToolView

  it('keeps the latest per-account survey gap, including pending and outside-run buckets', () => {
    const s = state()
    const current = s.runs.get('c')!
    recordReadGaps(current, surveyView())
    expect(readGapTotals(current)).toEqual({ open: 5, blocked: 1 })
    recordReadGaps(
      current,
      surveyView({
        coverage: {
          visible: 10,
          processed: 10,
          truncated: false,
          pending: 0,
          denied: [],
          unknown: [],
        },
      }),
    )
    expect(readGapTotals(current)).toEqual({ open: 0, blocked: 0 })
    recordReadGaps(current, surveyView({ scoped: true }))
    expect(readGapTotals(current)).toEqual({ open: 0, blocked: 0 })
  })

  it('never treats a one-bucket survey as account coverage', () => {
    const s = state()
    const current = s.runs.get('c')!
    const scoped = surveyView({
      scoped: true,
      coverage: {
        visible: 1,
        processed: 1,
        truncated: false,
        pending: 0,
        denied: [],
        unknown: [],
      },
    })
    recordReadGaps(current, scoped)
    expect(readGapTotals(current)).toEqual({ open: 1, blocked: 0 })
    recordReadGaps(current, surveyView())
    expect(readGapTotals(current)).toEqual({ open: 5, blocked: 1 })
    recordReadGaps(current, scoped)
    expect(readGapTotals(current)).toEqual({ open: 5, blocked: 1 })
  })

  it('replaces one bucket review without keeping an old blind spot', () => {
    const s = state()
    const current = s.runs.get('c')!
    const config = {
      kind: 'config',
      bucket: 'demo',
      providerId: 'p',
      aspect: 'access',
      findings: [{ severity: 'blind', title: 'Access denied', detail: '', code: 'blind:iam' }],
      permissions: [{ bucket: 'demo', item: 'IAM', action: 's3:GetBucketPolicy' }],
      accessCoverage: {
        principals: 10,
        evaluated: 8,
        undecided: 2,
        truncated: false,
        sources: ['iam'],
      },
    } as ToolView
    recordReadGaps(current, config)
    expect(readGapTotals(current)).toEqual({ open: 6, blocked: 2 })
    recordReadGaps(current, {
      ...config,
      findings: [],
      permissions: [],
      accessCoverage: {
        principals: 10,
        evaluated: 10,
        undecided: 0,
        truncated: false,
        sources: ['iam'],
      },
    } as ToolView)
    expect(readGapTotals(current)).toEqual({ open: 0, blocked: 0 })
  })

  it('corrects a clean claim once, but not a specific answer', () => {
    const s = state()
    recordReadGaps(s.runs.get('c')!, surveyView())
    expect(coverageCorrection(s, 'c', 'No public buckets.')).toMatch(/not complete/)
    expect(coverageCorrection(s, 'c', 'No public buckets.')).toBeUndefined()

    const specific = state()
    recordReadGaps(specific.runs.get('c')!, surveyView())
    expect(coverageCorrection(specific, 'c', '`demo` is not public.')).toBeUndefined()
  })
})
