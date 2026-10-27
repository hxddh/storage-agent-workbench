import type { Brief } from '@shared/brief'
import { readStateOfBrief } from '@shared/brief'
import { type Dict, fill } from './i18n'
import { ago } from './time'

export interface ScopeOptions {
  findings?: boolean
  memory?: boolean
}

/**
 * One source for the scope sentence. A narrowed re-read never makes an
 * account-wide gap complete; the sentence only repeats what the brief proves.
 */
export function scopeText(brief: Brief, t: Dict, options: ScopeOptions = {}): string {
  const read = readStateOfBrief(brief)
  const names = [...new Set(brief.coverage.map((item) => item.provider))].join(' · ')
  const coverage =
    read.open > 0
      ? `${fill(t.scopeOpen, { n: read.open })}${
          read.blocked > 0 ? ` · ${fill(t.scopeBlocked, { n: read.blocked })}` : ''
        }`
      : read.complete
        ? t.scopeComplete
        : ''
  const checked = brief.lastReadAt ? ago(brief.lastReadAt, t) : null
  const allMemory =
    brief.findings.length > 0 && brief.findings.every((finding) => finding.source === 'memory')
  const rememberedAt = allMemory
    ? ([...brief.findings].map((finding) => finding.readAt).sort()[0] ?? null)
    : null
  return [
    names,
    coverage,
    read.visible > 0 ? fill(t.scopeRead, { read: read.processed, total: read.visible }) : '',
    checked ? fill(t.checkedAt, { when: checked }) : '',
    options.findings && brief.findings.length > 0
      ? fill(t.findingsCount, { n: brief.findings.length })
      : '',
    options.memory && rememberedAt
      ? fill(t.rememberedAgo, { when: ago(rememberedAt, t) ?? '' })
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
