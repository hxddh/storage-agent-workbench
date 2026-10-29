/**
 * The one place Issues change.
 *
 * A storage tool reads; the rules decide; this module turns a reading's
 * decisions into Issue transitions and remembers what they were, so the tool
 * row can say "the rules opened 2 and resolved 1". Neither the model nor a tool
 * body ever opens, resolves or accepts an Issue. Accepting a risk is the
 * user's act and goes through `AppDb.setAccepted`.
 */
import type { Assessed, Observation } from '@shared/contract'
import type { AppDb } from '../db'
import { BY_CODE, type Decision } from './rules'

export class Assessor {
  readonly totals: Assessed = { opened: 0, resolved: 0, recurred: 0 }

  constructor(
    private readonly db: AppDb,
    private readonly conversationId: string | null,
  ) {}

  /** Apply one reading's decisions. An undecided rule is absent and changes nothing. */
  async apply(
    providerId: string,
    bucket: string,
    decisions: Record<string, Decision>,
  ): Promise<{ delta: Assessed; observations: Observation[] }> {
    const delta: Assessed = { opened: 0, resolved: 0, recurred: 0 }
    const observations: Observation[] = []
    for (const [code, decision] of Object.entries(decisions)) {
      if (decision.verdict === null) continue
      const rule = BY_CODE.get(code)
      if (!rule) continue
      const result = await this.db.upsertIssue({
        providerId,
        bucket,
        code,
        severity: rule.severity,
        observed: decision.verdict,
        detail: decision.detail,
        conversationId: this.conversationId,
      })
      if (result.event === 'opened') delta.opened += 1
      else if (result.event === 'resolved') delta.resolved += 1
      else if (result.event === 'recurred') delta.recurred += 1
      // Only a resolution changes what the run already shows; open Issues travel in the view.
      if (result.event === 'resolved')
        observations.push({ provider: providerId, bucket, code, verdict: false })
    }
    this.add(delta)
    return { delta, observations }
  }

  /** A complete listing no longer shows these buckets: their open Issues end as `gone`. */
  async gone(
    providerId: string,
    buckets: string[],
  ): Promise<{ resolved: number; observations: Observation[] }> {
    let resolved = 0
    const observations: Observation[] = []
    await this.db.markGone(providerId, buckets)
    for (const bucket of buckets) {
      for (const issue of await this.db.openIssuesFor(providerId, bucket)) {
        const result = await this.db.upsertIssue({
          providerId,
          bucket,
          code: issue.code,
          severity: issue.severity,
          observed: false,
          conversationId: this.conversationId,
          resolution: 'gone',
        })
        if (result.event) {
          resolved += 1
          observations.push({ provider: providerId, bucket, code: issue.code, verdict: false })
        }
      }
    }
    this.add({ opened: 0, resolved, recurred: 0 })
    return { resolved, observations }
  }

  private add(delta: Assessed): void {
    this.totals.opened += delta.opened
    this.totals.resolved += delta.resolved
    this.totals.recurred += delta.recurred
  }

  /** What this reading changed, or undefined when it changed nothing. */
  summary(): Assessed | undefined {
    const { opened, resolved, recurred } = this.totals
    return opened || resolved || recurred ? { ...this.totals } : undefined
  }
}
