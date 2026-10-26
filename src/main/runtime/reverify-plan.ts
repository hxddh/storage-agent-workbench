import type { FixPlan, ReverifyPlan, ReverifyPlanStep } from '@shared/contract'
import { type Decision, decideAccount } from '../estate/rules'
import type { AccountFacts } from '../s3/account'

type After = 'open' | 'accepted' | 'clear' | 'undecided'

/** The account rule is one decision, not a map keyed by rule code. */
export function planAccountDecisions(
  account: AccountFacts,
  aws: boolean,
  codes: readonly string[],
  lang: string,
): Record<string, Decision> {
  if (!codes.includes('account_public_access_block_missing')) return {}
  return { account_public_access_block_missing: decideAccount(account, aws, lang) }
}

/**
 * Compare a change plan with what a model-free replay actually read.
 *
 * A step is only confirmed when every code it covers was read and is now
 * clear. An unchecked bucket or an undecided rule stays unknown; an open or
 * accepted issue means the change was not applied. This is deliberately
 * conservative: a missing reading is not evidence that a fix worked.
 */
export function comparePlanToReplay(
  plan: FixPlan,
  checked: (bucket: string) => boolean,
  after: (bucket: string, code: string) => After | undefined,
): ReverifyPlan {
  const steps: ReverifyPlanStep[] = plan.steps.map((step) => {
    let status: ReverifyPlanStep['status'] = 'unknown'
    if (checked(step.bucket)) {
      const states = step.codes.map((code) => after(step.bucket, code))
      if (states.length > 0 && states.every((state) => state === 'clear')) status = 'confirmed'
      else if (states.some((state) => state === 'open' || state === 'accepted'))
        status = 'not_applied'
    }
    return {
      bucket: step.bucket,
      code: step.codes.join(', ') || step.id,
      title: step.title,
      status,
    }
  })
  return {
    steps,
    confirmed: steps.filter((step) => step.status === 'confirmed').length,
    notApplied: steps.filter((step) => step.status === 'not_applied').length,
    unknown: steps.filter((step) => step.status === 'unknown').length,
  }
}
