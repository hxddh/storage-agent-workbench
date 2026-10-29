import type { Lang, ToolView } from '@shared/contract'
import type { EvidenceRef } from '@shared/ledger'
import { type RunTrace, resolveEvidence } from '@shared/trace'
import { AlertTriangle, X } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { type Dict, fill, toolLabel } from './i18n'
import { AccessChain, ChangePlanView, ChartView, TableView, ToolViewBody } from './Views'

const Markdown = lazy(() => import('./Markdown'))

function plain(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1')
}

function Body({ view, t, taskTitle }: { view: ToolView; t: Dict; taskTitle: string }) {
  if (view.kind === 'change' && view.plan) return <ChangePlanView plan={view.plan} t={t} />
  if (view.kind === 'estate' && view.history) {
    const rows = view.history.rows.slice(0, 8)
    return (
      <ol className="run-timeline">
        {rows.map((row, index) => (
          <li key={index}>
            <span className="run-timeline-when mono">{String(row[0] ?? '')}</span>
            <span className="run-timeline-what">
              {row
                .slice(1)
                .filter((cell) => cell !== null && cell !== '' && cell !== '—' && cell !== '-')
                .map(String)
                .join(' · ')}
            </span>
          </li>
        ))}
      </ol>
    )
  }
  if (view.kind === 'survey')
    return (
      <TableView
        table={view.buckets}
        name={`${view.provider}-buckets`}
        empty={t.noBuckets}
        t={t}
        limit={8}
      />
    )
  if (view.kind === 'buckets' || view.kind === 'objects')
    return (
      <TableView
        table={view.rows}
        name={taskTitle || view.kind}
        empty={view.kind === 'buckets' ? t.noBuckets : t.noObjects}
        t={t}
        limit={8}
      />
    )
  if (view.kind === 'estate' && view.buckets)
    return (
      <TableView
        table={view.buckets}
        name={`${taskTitle || 'estate'}-buckets`}
        empty={t.emptyEstate}
        t={t}
        limit={8}
      />
    )
  if (view.kind === 'query')
    return (
      <>
        {view.chart && <ChartView chart={view.chart} />}
        <TableView table={view.rows} name={view.title} empty={t.noRows} t={t} limit={8} />
      </>
    )
  if (view.kind === 'config' && view.access)
    return (
      <AccessChain
        paths={view.access}
        blind={view.accessBlind}
        coverage={view.accessCoverage}
        t={t}
      />
    )
  return <ToolViewBody view={view} t={t} taskTitle={taskTitle} />
}

/** A citation opens its evidence in place; the full record is the trace. */
export function EvidencePeek({
  item,
  t,
  lang,
  taskTitle,
  onClose,
  onOpen,
}: {
  item: EvidenceRef
  t: Dict
  lang: Lang
  taskTitle: string
  onClose: () => void
  onOpen: () => void
}) {
  if (!item.view) return null
  return (
    <section className="run-peek" aria-label={`${toolLabel(item.name, lang)} ${item.target}`}>
      <div className="run-peek-head">
        <span className="run-section-title">
          {toolLabel(item.name, lang)} · {item.target}
        </span>
        <span className={`run-peek-status ${item.status}`}>{item.status}</span>
        <button className="text-action" type="button" onClick={onOpen}>
          {t.runOpenEvidence}
        </button>
        <button className="icon-btn" type="button" aria-label={t.close} onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="run-peek-body">
        <Body view={item.view} t={t} taskTitle={taskTitle} />
      </div>
    </section>
  )
}

function Note({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <p className={className}>
      <AlertTriangle size={12} strokeWidth={1.7} aria-hidden="true" />
      {children}
    </p>
  )
}

/** The model's prose (or a scripted run's sentence), with its citations and marks. */
export function Answer({
  trace,
  live,
  t,
  onCite,
}: {
  trace: RunTrace
  live: boolean
  t: Dict
  onCite: (entryId: string) => void
}) {
  const answer = trace.answer
  const text = answer?.text ?? ''
  const check = answer?.check
  const ungrounded = new Set(check?.ungrounded ?? [])
  const components = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      const raw = href?.match(/^#ev-(.+)$/)?.[1]
      const item = raw ? resolveEvidence(trace, decodeURIComponent(raw)) : undefined
      if (item)
        return (
          <button
            className="run-cite"
            type="button"
            title={`${t.runEvidenceTitle} ${item.target}`}
            onClick={() => onCite(item.entryId)}
          >
            {children}
          </button>
        )
      return href && /^https?:\/\//i.test(href) ? (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : (
        children
      )
    },
    code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
      const value = typeof children === 'string' ? children.trim() : ''
      return value && ungrounded.has(value) ? (
        <code className="ungrounded" title={t.ungroundedNote}>
          {children}
        </code>
      ) : (
        <code className={className}>{children}</code>
      )
    },
  }
  return (
    <section
      className="run-answer"
      aria-label={t.runAnswerTitle}
      aria-live="polite"
      aria-atomic="false"
    >
      {text ? (
        <div className="verdict prose run-summary" data-verdict>
          <Suspense fallback={<p>{plain(text)}</p>}>
            <Markdown text={text} components={components} />
          </Suspense>
        </div>
      ) : live ? null : (
        <p className="quiet">{t.runNoAnswer}</p>
      )}
      {check && check.unresolved.length > 0 && (
        <Note className="quiet run-unresolved">
          {check.unresolved.length === 1
            ? t.runUnresolvedCitationsOne
            : fill(t.runUnresolvedCitations, { n: check.unresolved.length })}
        </Note>
      )}
      {check && ungrounded.size > 0 && <Note className="grounding">{t.ungroundedNote}</Note>}
      {check && check.uncited.length > 0 && (
        <Note className="grounding">
          {fill(t.uncitedNote, { names: check.uncited.slice(0, 4).join(', ') })}
        </Note>
      )}
    </section>
  )
}
