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
 *
 * User-facing copy avoids "reads complete": it says which buckets were checked,
 * or that the answer came from memory and when that memory was written.
 */
export function scopeText(brief: Brief, t: Dict, options: ScopeOptions = {}): string {
  const read = readStateOfBrief(brief)
  const dataName = brief.data?.view.kind === 'estate' ? brief.data.title : null
  const names = [
    ...new Set([
      ...brief.coverage
        .map((item) => item.provider)
        .filter((name): name is string => Boolean(name)),
      ...(dataName ? [dataName] : []),
    ]),
  ].join(' · ')
  // All buckets can be surveyed while access questions remain open. Say both
  // facts; "Not fully checked" beside "6/6 buckets checked" reads as a
  // contradiction even though the counts are honest.
  const allChecked = read.visible > 0 && read.processed === read.visible
  const coverage =
    read.open > 0
      ? `${
          allChecked
            ? fill(read.open === 1 ? t.scopeAllOpenOne : t.scopeAllOpen, {
                n: read.visible,
                open: read.open,
              })
            : fill(t.scopeOpen, { n: read.open })
        }${read.blocked > 0 ? ` · ${fill(t.scopeBlocked, { n: read.blocked })}` : ''}`
      : read.complete
        ? fill(read.visible === 1 ? t.scopeCompleteOne : t.scopeComplete, { n: read.visible })
        : ''
  const checked = brief.lastReadAt ? ago(brief.lastReadAt, t) : null
  const allMemory =
    brief.findings.length > 0 && brief.findings.every((finding) => finding.source === 'memory')
  const rememberedAt = allMemory
    ? ([...brief.findings]
        .map((finding) => finding.readAt)
        .sort()
        .at(-1) ?? null)
    : brief.data?.memory
      ? brief.data.at
      : null
  const planBaseline = brief.fixes.find((fix) => fix.view.plan?.baseline)?.view.plan?.baseline
  const freshness = rememberedAt
    ? fill(t.scopeMemory, { when: ago(rememberedAt, t) ?? t.justNow })
    : read.open > 0 || read.complete
      ? ''
      : brief.lastReadAt
        ? fill(t.scopeLive, { when: ago(brief.lastReadAt, t) ?? t.justNow })
        : planBaseline
          ? fill(t.scopePlan, { when: ago(planBaseline.at, t) ?? t.justNow })
          : t.scopeNoRead
  return [
    names,
    coverage || freshness,
    read.visible > 0 && !read.complete && !allChecked
      ? fill(t.scopeRead, { read: read.processed, total: read.visible })
      : '',
    checked && coverage ? fill(t.checkedAt, { when: checked }) : '',
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
