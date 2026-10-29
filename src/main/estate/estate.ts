import type { IssueRow } from '@shared/contract'
import type { AppDb, IssueRecord } from '../db'
import { BY_CODE, ruleTitle } from './rules'

/**
 * Read access to the estate's memory. Issue transitions live in `assess.ts`;
 * this class only reads and shapes.
 */
export class Estate {
  constructor(private readonly db: AppDb) {}

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
