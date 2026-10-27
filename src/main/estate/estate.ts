import type { IssueRow } from '@shared/contract'
import type { AppDb, IssueRecord } from '../db'
import { BY_CODE, type Decision, ruleTitle } from './rules'

export interface Delta {
  opened: number
  resolved: number
  recurred: number
}

/** What one reading decided about one bucket, for the run's current-state view. */
export interface Observation {
  provider: string
  bucket: string
  code: string
  verdict: boolean
}

export class Estate {
  constructor(private readonly db: AppDb) {}

  /** Apply one reading's decisions. Undecided rules are absent and change nothing. */
  async apply(
    providerId: string,
    bucket: string,
    decisions: Record<string, Decision>,
    conversationId: string | null,
  ): Promise<{ delta: Delta; observations: Observation[] }> {
    const delta: Delta = { opened: 0, resolved: 0, recurred: 0 }
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
        conversationId,
      })
      if (result.event === 'opened') delta.opened += 1
      else if (result.event === 'resolved') delta.resolved += 1
      else if (result.event === 'recurred') delta.recurred += 1
      // Only a resolution changes what the run already shows; open Issues travel in the view.
      if (result.event === 'resolved')
        observations.push({ provider: providerId, bucket, code, verdict: false })
    }
    return { delta, observations }
  }

  /**
   * A complete listing no longer shows these buckets: their open Issues end as
   * `gone`, and every rule is observed absent for them.
   */
  async gone(
    providerId: string,
    buckets: string[],
    conversationId: string | null,
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
          conversationId,
          resolution: 'gone',
        })
        if (result.event) {
          resolved += 1
          observations.push({ provider: providerId, bucket, code: issue.code, verdict: false })
        }
      }
    }
    return { resolved, observations }
  }

  /** Open and accepted Issues, most severe first. */
  async issueRows(providerId: string | undefined, lang: string, limit = 50): Promise<IssueRow[]> {
    const open = await this.db.listIssues({ providerId, status: 'open', limit })
    const accepted = await this.db.listIssues({ providerId, status: 'accepted', limit })
    return this.toRows([...open, ...accepted].slice(0, limit), lang)
  }

  toRows(records: IssueRecord[], lang: string): IssueRow[] {
    return records.map((issue) => ({
      id: issue.id,
      provider: issue.provider_id,
      bucket: issue.bucket,
      code: issue.code,
      severity: issue.severity,
      status: issue.status,
      title: BY_CODE.has(issue.code) ? ruleTitle(BY_CODE.get(issue.code)!, lang) : issue.code,
      ...(BY_CODE.get(issue.code)?.control ? { control: BY_CODE.get(issue.code)!.control } : {}),
      detail: issue.detail,
      openedAt: issue.opened_at,
      lastSeenAt: issue.last_seen_at,
      recurred: issue.recurred,
    }))
  }

  async postureOf(providerId: string, bucket: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db.listBuckets(providerId)
    const row = rows.find((r) => r.name === bucket)
    if (!row?.posture_json) return null
    try {
      return JSON.parse(row.posture_json) as Record<string, unknown>
    } catch {
      return null
    }
  }
}
