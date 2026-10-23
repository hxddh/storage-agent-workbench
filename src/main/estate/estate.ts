import type { IssueRow } from '@shared/contract'
import type { AppDb, IssueRecord } from '../db'
import { BY_CODE, ruleTitle, type Verdict } from './rules'

export interface Delta {
  opened: number
  resolved: number
  recurred: number
}

export class Estate {
  constructor(private readonly db: AppDb) {}

  async apply(
    providerId: string,
    bucket: string,
    verdicts: Record<string, Verdict>,
    conversationId: string | null,
  ): Promise<Delta> {
    const delta: Delta = { opened: 0, resolved: 0, recurred: 0 }
    for (const [code, verdict] of Object.entries(verdicts)) {
      if (verdict === null) continue
      const rule = BY_CODE.get(code)
      if (!rule) continue
      const result = await this.db.upsertIssue({
        providerId,
        bucket,
        code,
        severity: rule.severity,
        observed: verdict,
        conversationId,
      })
      if (result.event === 'opened') delta.opened += 1
      else if (result.event === 'resolved') delta.resolved += 1
      else if (result.event === 'recurred') delta.recurred += 1
    }
    return delta
  }

  async issueRows(providerId: string | undefined, lang: string, limit = 50): Promise<IssueRow[]> {
    const records = await this.db.listIssues({ providerId, status: 'open', limit })
    return this.toRows(records, lang)
  }

  async toRows(records: IssueRecord[], lang: string): Promise<IssueRow[]> {
    return records.map((issue) => ({
      id: issue.id,
      provider: issue.provider_id,
      bucket: issue.bucket,
      code: issue.code,
      severity: issue.severity,
      status: issue.status,
      title: BY_CODE.has(issue.code) ? ruleTitle(BY_CODE.get(issue.code)!, lang) : issue.code,
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

  async bucketCount(providerId: string): Promise<number> {
    return this.db.countBuckets(providerId)
  }
}
