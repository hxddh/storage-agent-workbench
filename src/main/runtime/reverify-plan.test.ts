import type { ChangePlan } from '@shared/contract'
import { describe, expect, it } from 'vitest'
import { comparePlanToReplay, planAccountDecisions } from './reverify-plan'

const step = (id: string, bucket: string, codes: string[]) => ({
  id,
  bucket,
  codes,
  title: id,
  severity: 'high' as const,
  formats: [],
  impact: { verdict: 'low' as const, reasons: [], gap: null },
  notes: [],
  status: 'ready' as const,
  blockers: [],
})

const plan: ChangePlan = {
  summary: '',
  baseline: null,
  residual: [],
  steps: [step('public', 'demo', ['public_exposure']), step('mixed', 'demo', ['a', 'b'])],
}

describe('comparing a change plan with a re-verification', () => {
  it('confirms only steps whose every code was read and is now clear', () => {
    const result = comparePlanToReplay(
      plan,
      () => true,
      (_bucket, code) => (code === 'public_exposure' ? 'clear' : 'open'),
    )
    expect(result.steps.map((item) => [item.code, item.status])).toEqual([
      ['public_exposure', 'confirmed'],
      ['a, b', 'not_applied'],
    ])
    expect([result.confirmed, result.notApplied, result.unknown]).toEqual([1, 1, 0])
  })

  it('does not treat a missing or undecided reading as a confirmed fix', () => {
    const result = comparePlanToReplay(
      plan,
      () => false,
      () => 'clear',
    )
    expect(result.steps.every((item) => item.status === 'unknown')).toBe(true)

    const undecided = comparePlanToReplay(
      plan,
      () => true,
      (_bucket, code) => (code === 'a' ? 'clear' : 'undecided'),
    )
    expect(undecided.steps[1]?.status).toBe('unknown')
    expect(undecided.confirmed).toBe(0)

    const missing = comparePlanToReplay(
      plan,
      () => true,
      (_bucket, code) => (code === 'a' ? 'clear' : undefined),
    )
    expect(missing.steps[1]?.status).toBe('unknown')
  })

  it('treats an accepted risk as not applied, not as fixed', () => {
    const result = comparePlanToReplay(
      plan,
      () => true,
      () => 'accepted',
    )
    expect(result.steps.every((item) => item.status === 'not_applied')).toBe(true)
  })

  it('keys the one account decision by its rule code, and only when the plan asks', () => {
    const account = { pab: { status: 'not_configured' as const, value: null } }
    const asked = planAccountDecisions(account, true, ['account_public_access_block_missing'], 'en')
    expect(asked.account_public_access_block_missing?.verdict).toBe(true)
    expect(planAccountDecisions(account, true, ['no_abort_mpu'], 'en')).toEqual({})
    expect(
      planAccountDecisions(
        { pab: { status: 'unread' as const, value: null } },
        true,
        ['account_public_access_block_missing'],
        'en',
      ).account_public_access_block_missing?.verdict,
    ).toBeNull()
  })
})
