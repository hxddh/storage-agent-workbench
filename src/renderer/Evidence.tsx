import type { RiskFact, RunTrace } from '@shared/trace'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { type Dict, fill } from './i18n'

function severityLabel(finding: RiskFact, t: Dict): string {
  return finding.severity === 'high'
    ? t.severityHigh
    : finding.severity === 'medium'
      ? t.severityMedium
      : t.severityLow
}

function FindingLine({ finding, t, onOpen }: { finding: RiskFact; t: Dict; onOpen: () => void }) {
  return (
    <div className="run-finding-line">
      <button className="run-finding-main" type="button" onClick={onOpen}>
        <span className={`run-finding-severity ${finding.severity}`}>
          {severityLabel(finding, t)}
        </span>
        <span className="run-finding-bucket mono">{finding.bucket || t.accountWide}</span>
        <span className="run-finding-title">{finding.title}</span>
        {finding.source === 'memory' && <span className="run-finding-tag">{t.remembered}</span>}
      </button>
      {finding.issueId && (
        <button
          className="text-action"
          type="button"
          onClick={() =>
            void window.agent.acceptIssue(finding.issueId!, finding.status !== 'accepted')
          }
        >
          {finding.status === 'accepted' ? t.reopen : t.acceptRisk}
        </button>
      )}
    </div>
  )
}

/** j/k move between findings, a accepts the focused one. */
function navigate(event: React.KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement
  if (!target.classList.contains('run-finding-main')) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('.run-finding-main')]
  const index = rows.indexOf(target)
  if (event.key === 'j' || event.key === 'ArrowDown') {
    event.preventDefault()
    rows[Math.min(rows.length - 1, index + 1)]?.focus()
  } else if (event.key === 'k' || event.key === 'ArrowUp') {
    event.preventDefault()
    rows[Math.max(0, index - 1)]?.focus()
  } else if (event.key === 'a') {
    event.preventDefault()
    target.closest('.run-finding-line')?.querySelector<HTMLButtonElement>('.text-action')?.click()
  }
}

function FindingsPanel({
  trace,
  t,
  onOpen,
}: {
  trace: RunTrace
  t: Dict
  onOpen: (id: string) => void
}) {
  const { findings: open, accepted, resolved } = trace
  if (!open.length && !accepted.length && !resolved.length)
    return <p className="quiet run-panel-empty">{t.noIssues}</p>
  return (
    <section className="run-panel" aria-label={t.runFindings} onKeyDown={navigate}>
      {open.map((finding) => (
        <FindingLine
          key={finding.key}
          finding={finding}
          t={t}
          onOpen={() => onOpen(finding.sourceId)}
        />
      ))}
      {accepted.length > 0 && (
        <p className="run-panel-label">
          {accepted.length === 1 ? t.acceptedOne : fill(t.acceptedCount, { n: accepted.length })}
        </p>
      )}
      {accepted.map((finding) => (
        <FindingLine
          key={finding.key}
          finding={finding}
          t={t}
          onOpen={() => onOpen(finding.sourceId)}
        />
      ))}
      {resolved.length > 0 && (
        <p className="run-panel-label ok">
          {resolved.length === 1 ? t.fixedOne : fill(t.fixedCount, { n: resolved.length })}
        </p>
      )}
      {resolved.map((finding) => (
        <p className="run-resolved-line" key={finding.key}>
          <span className="mono">{finding.bucket}</span> · {finding.title}
        </p>
      ))}
    </section>
  )
}

function Gap({ children }: { children: React.ReactNode }) {
  return (
    <p className="blind">
      <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
      {children}
    </p>
  )
}

/** Everything the run's reads left open. Shown even when the answer does not mention it. */
function NotCheckedPanel({ trace, t }: { trace: RunTrace; t: Dict }) {
  const read = trace.read
  const { blind, undecided } = trace.ledger
  const empty =
    read.open === 0 &&
    trace.gone.length === 0 &&
    !undecided.length &&
    !blind.length &&
    !read.permissions.length
  return (
    <section className="run-panel run-coverage-panel" aria-label={t.runCoverage}>
      {empty && (
        <p className="quiet run-panel-empty">{fill(t.scopeComplete, { n: read.visible })}</p>
      )}
      {read.unread > 0 && <Gap>{fill(t.blind, { n: read.unread })}</Gap>}
      {read.pending > 0 && <Gap>{fill(t.pendingBuckets, { n: read.pending })}</Gap>}
      {read.truncated > 0 && <Gap>{fill(t.scopeTruncated, { n: read.truncated })}</Gap>}
      {read.failed > 0 && <Gap>{fill(t.failedReads, { n: read.failed })}</Gap>}
      {read.access > 0 && <Gap>{fill(t.accessOpen, { n: read.access })}</Gap>}
      {undecided.map((item) => (
        <Gap key={item.code}>
          {fill(t.undecidedRule, {
            n: item.count,
            title: item.title,
            buckets: item.buckets.slice(0, 6).join(', '),
          })}
        </Gap>
      ))}
      {blind.map((item) => (
        <Gap key={item.key}>
          <span className="mono">{item.bucket}</span> · {item.title}
        </Gap>
      ))}
      {read.permissions.slice(0, 12).map((gap) => (
        <p className="blind permission-gap" key={`${gap.bucket}:${gap.action}`}>
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
          <span className="mono">{gap.bucket}</span> · {gap.item} · <code>{gap.action}</code>
        </p>
      ))}
      {trace.gone.length > 0 && (
        <p className="quiet">{fill(t.goneBuckets, { names: trace.gone.join(', ') })}</p>
      )}
    </section>
  )
}

/** Two strips: **Findings** and **Not checked**, only when they have content. */
export function Evidence({
  trace,
  open,
  onOpen,
  onReveal,
  t,
}: {
  trace: RunTrace
  open: 'findings' | 'coverage' | null
  onOpen: (panel: 'findings' | 'coverage' | null) => void
  onReveal: (entryId: string) => void
  t: Dict
}) {
  const findings = trace.findings.length + trace.accepted.length
  const notChecked = trace.read.open + trace.gone.length
  if (!findings && !notChecked) return null
  const strip = (panel: 'findings' | 'coverage', title: string, count: string) => (
    <button
      className={`run-evidence-button ${open === panel ? 'open' : ''}`}
      type="button"
      aria-expanded={open === panel}
      onClick={() => onOpen(open === panel ? null : panel)}
    >
      <span className="run-section-title">{title}</span>
      <span className="run-evidence-count">{count}</span>
      <ChevronRight size={13} className={`chev ${open === panel ? 'open' : ''}`} />
    </button>
  )
  return (
    <>
      <div className="run-evidence-strip">
        {findings > 0 &&
          strip(
            'findings',
            t.runFindings,
            trace.findings.length > 0
              ? trace.findings.length === 1
                ? t.findingsCountOne
                : fill(t.findingsCount, { n: trace.findings.length })
              : trace.accepted.length === 1
                ? t.acceptedOne
                : fill(t.acceptedCount, { n: trace.accepted.length }),
          )}
        {notChecked > 0 && strip('coverage', t.runNotChecked, String(notChecked))}
      </div>
      {open === 'findings' && <FindingsPanel trace={trace} t={t} onOpen={onReveal} />}
      {open === 'coverage' && <NotCheckedPanel trace={trace} t={t} />}
    </>
  )
}
