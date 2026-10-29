import type { RunTrace } from '@shared/trace'
import { type Dict, fill } from './i18n'
import { ago } from './time'

/**
 * The scope line: one sentence from the ledger, never from the answer's prose.
 * A narrowed re-read never makes an account-wide gap complete; it says which
 * buckets were checked, or that the answer came from memory and when.
 */
export function scopeText(trace: RunTrace, t: Dict): string {
  const read = trace.read
  const names = [
    ...new Set(trace.ledger.coverage.map((item) => item.provider).filter(Boolean)),
  ].join(' · ')
  // All buckets can be surveyed while access questions remain open: say both,
  // so "Not fully checked" never sits beside "6/6 buckets checked".
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
  const lastRead = trace.ledger.lastReadAt
  const freshness = trace.memoryAt
    ? fill(t.scopeMemory, { when: ago(trace.memoryAt, t) ?? t.justNow })
    : coverage
      ? ''
      : lastRead
        ? fill(t.scopeLive, { when: ago(lastRead, t) ?? t.justNow })
        : trace.planAt
          ? fill(t.scopePlan, { when: ago(trace.planAt, t) ?? t.justNow })
          : t.scopeNoRead
  const checked = lastRead ? ago(lastRead, t) : null
  return [
    names,
    coverage || freshness,
    read.visible > 0 && !read.complete && !allChecked
      ? fill(t.scopeRead, { read: read.processed, total: read.visible })
      : '',
    checked && coverage ? fill(t.checkedAt, { when: checked }) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
