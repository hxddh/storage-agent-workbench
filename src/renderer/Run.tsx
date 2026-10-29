import { buildActivity } from '@shared/activity'
import {
  type AuditProgress,
  type Lang,
  type LocalModel,
  TASK_LINK_PREFIX,
  type TaskModel,
  type TaskView,
  type ToolView,
} from '@shared/contract'
import type { RiskFact } from '@shared/facts'
import {
  buildTrace,
  currentRunEntries,
  type RunEvidence,
  type RunTrace,
  type RunTurn,
  resolveEvidence,
  type TraceEvent,
  traceMarkdown,
  turnsOf,
} from '@shared/trace'
import {
  AlertTriangle,
  ArrowDownToLine,
  ChevronRight,
  Copy,
  Link2,
  MoreHorizontal,
  Radar,
  X,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Work } from './Activity'
import { type Dict, dict, fill, toolLabel } from './i18n'
import { copyText, safeFileName } from './lib/export'
import { noticeText } from './notice'
import { scopeText } from './scope'
import { ago } from './time'
import { AccessChain, ChangePlanView, ChartView, TableView, ToolViewBody } from './Views'

const Markdown = lazy(() => import('./Markdown'))

function plain(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1')
}

function TableBlock({
  view,
  limit,
  t,
  taskTitle,
}: {
  view: ToolView
  limit?: number
  t: Dict
  taskTitle: string
}) {
  if (view.kind === 'survey')
    return (
      <TableView
        table={view.buckets}
        name={`${view.provider}-buckets`}
        empty={t.noBuckets}
        t={t}
        limit={limit ?? 10}
      />
    )
  if (view.kind === 'buckets' || view.kind === 'objects')
    return (
      <TableView
        table={view.rows}
        name={taskTitle || view.kind}
        empty={view.kind === 'buckets' ? t.noBuckets : t.noObjects}
        t={t}
        limit={limit ?? 10}
      />
    )
  if (view.kind === 'estate' && view.buckets)
    return (
      <TableView
        table={view.buckets}
        name={`${taskTitle || 'estate'}-buckets`}
        empty={t.emptyEstate}
        t={t}
        limit={limit ?? 8}
      />
    )
  if (view.kind === 'query')
    return (
      <>
        {view.chart && <ChartView chart={view.chart} />}
        <TableView table={view.rows} name={view.title} empty={t.noRows} t={t} limit={limit ?? 10} />
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

function TimelineBlock({ view, limit, t }: { view: ToolView; limit?: number; t: Dict }) {
  const table =
    view.kind === 'estate' && view.history ? view.history : view.kind === 'query' ? view.rows : null
  if (!table) return <p className="view-empty">{t.noRows}</p>
  const rows = table.rows.slice(0, limit ?? 10)
  return (
    <ol className="run-timeline">
      {rows.map((row, index) => (
        <li key={index}>
          <span className="run-timeline-when mono">{String(row[0] ?? '')}</span>
          <span className="run-timeline-what">
            {row
              .slice(1)
              .filter((cell) => cell !== null && cell !== '' && cell !== '—' && cell !== '-')
              .map((cell) => String(cell))
              .join(' · ')}
          </span>
        </li>
      ))}
    </ol>
  )
}

function EvidencePeek({
  item,
  t,
  lang,
  taskTitle,
  onClose,
  onOpen,
}: {
  item: RunEvidence
  t: Dict
  lang: Lang
  taskTitle: string
  onClose: () => void
  onOpen: () => void
}) {
  if (!item.view) return null
  const view = item.view
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
        {view.kind === 'change' && view.plan ? (
          <ChangePlanView plan={view.plan} t={t} />
        ) : view.kind === 'estate' && view.history ? (
          <TimelineBlock view={view} limit={8} t={t} />
        ) : (
          <TableBlock view={view} limit={8} t={t} taskTitle={taskTitle} />
        )}
      </div>
    </section>
  )
}

function TurnHistory({
  turns,
  t,
  open,
  onToggle,
  selected,
  onSelect,
}: {
  turns: RunTurn[]
  t: Dict
  open: boolean
  onToggle: () => void
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  if (!turns.length) return null
  return (
    <section className="run-history" aria-label={t.runEarlier}>
      <button className="run-history-head" type="button" aria-expanded={open} onClick={onToggle}>
        <span className="run-section-title">{t.runEarlier}</span>
        <span className="run-history-count">{turns.length}</span>
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <ol className="run-turn-list">
          {turns.map((turn) => {
            const expanded = selected === turn.id
            const summary = turn.answer?.text
              ? plain(
                  turn.answer.text
                    .replace(/^#{1,6}\s+/gm, '')
                    .replace(/^[-*]\s+/gm, '')
                    .replace(/\s+/g, ' ')
                    .trim(),
                )
              : null
            return (
              <li key={turn.id} className="run-turn">
                <button
                  className="run-turn-head"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => onSelect(expanded ? null : turn.id)}
                >
                  <span className="run-turn-question">
                    {turn.question?.text ?? t.runDeterministicCheck}
                  </span>
                  <span className="run-turn-meta">
                    {ago(turn.at, t) ?? ''} ·{' '}
                    {turn.checks === 1
                      ? t.checkOne
                      : `${turn.checks} ${t.checksTitle.toLowerCase()}`}
                  </span>
                  <ChevronRight size={13} className={`chev ${expanded ? 'open' : ''}`} />
                </button>
                {expanded && (
                  <div className="run-turn-body">
                    {summary ? (
                      <p className="run-turn-summary">{summary.slice(0, 700)}</p>
                    ) : (
                      <p className="quiet">{t.runNoAnswer}</p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

function ClarifyCard({
  clarify,
  t,
  onClarify,
}: {
  clarify: NonNullable<RunTrace['clarify']>
  t: Dict
  onClarify: (text: string) => void
}) {
  return (
    <section className="run-clarify" aria-label={t.runClarifyTitle}>
      <div className="run-section-head">
        <span className="run-section-title">{t.runClarifyTitle}</span>
        {clarify.note && <span className="run-section-note">{clarify.note}</span>}
      </div>
      <p className="run-clarify-question">{clarify.question}</p>
      <div className="run-clarify-options">
        {clarify.options.map((option, index) => (
          <button
            className="btn"
            type="button"
            key={`${option}:${index}`}
            onClick={() => onClarify(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </section>
  )
}

function RunNotices({
  notices,
  t,
  onRetry,
  onContinue,
}: {
  notices: RunTrace['facts']['notices']
  t: Dict
  onRetry: () => void
  onContinue: () => void
}) {
  if (!notices.length) return null
  return (
    <div className="run-notices">
      {notices.map((notice) => (
        <div
          className={`notice ${notice.tone}`}
          key={notice.id}
          role={notice.tone === 'error' ? 'alert' : undefined}
        >
          <span className="dot" aria-hidden="true" />
          <span className="text">{noticeText(notice, t)}</span>
          {notice.action && (
            <button
              className="text-action"
              type="button"
              onClick={notice.action === 'retry' ? onRetry : onContinue}
            >
              {notice.action === 'retry' ? t.retry : t.continue}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

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

function FindingsPanel({
  trace,
  resolved,
  t,
  onOpen,
}: {
  trace: RunTrace
  resolved: RiskFact[]
  t: Dict
  onOpen: (id: string) => void
}) {
  const open = trace.findings
  const accepted = trace.accepted
  if (!open.length && !accepted.length && !resolved.length)
    return <p className="quiet run-panel-empty">{t.noIssues}</p>
  const navigate = (event: React.KeyboardEvent<HTMLElement>) => {
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

function CoveragePanel({ trace, t }: { trace: RunTrace; t: Dict }) {
  const read = trace.coverage
  const gone = trace.facts.coverage.flatMap((item) => item.gone)
  const empty =
    read.open === 0 &&
    gone.length === 0 &&
    trace.facts.undecided.length === 0 &&
    trace.facts.blind.length === 0 &&
    read.permissions.length === 0
  return (
    <section className="run-panel run-coverage-panel" aria-label={t.runCoverage}>
      {empty && (
        <p className="quiet run-panel-empty">
          {t.scopeComplete.replace('{n}', String(read.visible))}
        </p>
      )}
      {read.unread > 0 && (
        <p className="blind">
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.blind, { n: read.unread })}
        </p>
      )}
      {read.pending > 0 && (
        <p className="blind">
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.pendingBuckets, { n: read.pending })}
        </p>
      )}
      {read.truncated > 0 && (
        <p className="blind">
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.scopeTruncated, { n: read.truncated })}
        </p>
      )}
      {read.failed > 0 && (
        <p className="blind">
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.failedReads, { n: read.failed })}
        </p>
      )}
      {read.access > 0 && (
        <p className="blind">
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.accessOpen, { n: read.access })}
        </p>
      )}
      {trace.facts.undecided.map((item) => (
        <p className="blind" key={item.code}>
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.undecidedRule, {
            n: item.count,
            title: item.title,
            buckets: item.buckets.slice(0, 6).join(', '),
          })}
        </p>
      ))}
      {trace.facts.blind.map((item) => (
        <p className="blind" key={item.key}>
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
          <span className="mono">{item.bucket}</span> · {item.title}
        </p>
      ))}
      {read.permissions.slice(0, 12).map((gap) => (
        <p className="blind permission-gap" key={`${gap.bucket}:${gap.action}`}>
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
          <span className="mono">{gap.bucket}</span> · {gap.item} · <code>{gap.action}</code>
        </p>
      ))}
      {gone.length > 0 && (
        <p className="quiet">{fill(t.goneBuckets, { names: gone.join(', ') })}</p>
      )}
    </section>
  )
}

export function Run({
  view,
  lang,
  focusId,
  onRetry,
  onContinue,
  onReverify,
  onClarify,
  onOlder = async () => undefined,
  onAudit = () => undefined,
  auditing = false,
  auditProgress = null,
  modelLabel = null,
  models = [],
  onModel,
}: {
  view: TaskView
  lang: Lang
  focusId: string | null
  modelLabel?: string | null
  models?: LocalModel[]
  onModel?: (model: TaskModel | null) => void
  onRetry: () => void
  onContinue: () => void
  onReverify: () => Promise<void>
  onClarify?: (text: string) => void
  onOlder?: () => Promise<void>
  onAudit?: () => void
  auditing?: boolean
  auditProgress?: AuditProgress | null
}) {
  const t = dict(lang)
  const currentEntries = useMemo(() => currentRunEntries(view.entries), [view.entries])
  const trace = useMemo(
    () => buildTrace(currentEntries, view.live, view.issueStatus, view.usage),
    [currentEntries, view.live, view.issueStatus, view.usage],
  )
  // The resolved fold is task memory: it needs the earlier observation that
  // the current read proved fixed.
  const taskTrace = useMemo(
    () => buildTrace(view.entries, null, view.issueStatus, view.usage),
    [view.entries, view.issueStatus, view.usage],
  )
  const [peekId, setPeekId] = useState<string | null>(null)
  const [workOpen, setWorkOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [linked, setLinked] = useState(false)
  const [more, setMore] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedTurn, setSelectedTurn] = useState<string | null>(null)
  const [findingsOpen, setFindingsOpen] = useState(false)
  const [coverageOpen, setCoverageOpen] = useState(false)
  const turns = useMemo(
    () => turnsOf(view.entries, view.issueStatus),
    [view.entries, view.issueStatus],
  )
  const earlierTurns = useMemo(() => turns.slice(0, -1), [turns])
  const activity = useMemo(
    () => buildActivity(currentEntries, view.live),
    [currentEntries, view.live],
  )
  const peek = useMemo(
    () => (peekId ? resolveEvidence(trace.evidence, peekId) : undefined),
    [peekId, trace.evidence],
  )
  const validation = useMemo(
    () =>
      trace.events.filter(
        (event): event is Extract<TraceEvent, { kind: 'validation' }> =>
          event.kind === 'validation',
      ),
    [trace.events],
  )
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!more) return
    const close = () => setMore(false)
    const timer = window.setTimeout(
      () => window.addEventListener('click', close, { once: true }),
      0,
    )
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMore(false)
      }
    }
    window.addEventListener('keydown', key)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', key)
    }
  }, [more])

  const question = trace.audit ? null : (trace.question?.text ?? null)
  const answer = trace.answer
  const stale = Boolean(answer?.stale)
  const answerText = answer?.text ?? ''
  const ungrounded = new Set(stale ? [] : (answer?.ungrounded ?? []))
  const contradicted = new Set(stale ? [] : (answer?.contradicted ?? []))
  const stopped = trace.facts.notices.some((notice) => notice.code === 'stopped')
  const planVisible =
    Boolean(view.live) ||
    stopped ||
    Boolean(trace.plan?.steps.some((step) => step.status === 'blocked'))
  const turnKey = trace.question?.id ?? view.task.id
  const gone = trace.facts.coverage.flatMap((item) => item.gone)
  const notChecked = trace.coverage.open + gone.length
  const findingsCount = trace.findings.length + trace.accepted.length
  const traceFirst = !answerText && (trace.phase === 'planning' || trace.phase === 'investigating')
  const noticesFirst = trace.phase === 'stopped' || trace.phase === 'failed'
  const clarifyFirst = trace.phase === 'clarifying'

  useEffect(() => {
    if (!turnKey) return
    setPeekId(null)
    setWorkOpen(false)
    setMore(false)
    setHistoryOpen(false)
    setSelectedTurn(null)
    setFindingsOpen(false)
    setCoverageOpen(false)
  }, [turnKey])

  const openTrace = useCallback((entryId?: string) => {
    setPeekId(null)
    setWorkOpen(true)
    setTimeout(() => {
      const element = entryId
        ? root.current?.querySelector<HTMLElement>(`[data-trace-id="${CSS.escape(entryId)}"]`)
        : root.current?.querySelector<HTMLElement>('.run-work')
      element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 40)
  }, [])

  useEffect(() => {
    if (!focusId) return
    if (focusId === 'answer') {
      setWorkOpen(false)
      root.current
        ?.querySelector<HTMLElement>('.run-answer')
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    if (focusId.startsWith('f:')) {
      const rest = focusId.slice(2)
      const key = rest.slice(rest.indexOf(':') + 1)
      const finding = [...trace.findings, ...trace.accepted].find((item) => item.key === key)
      setFindingsOpen(true)
      setCoverageOpen(false)
      if (finding) setPeekId(finding.sourceId)
      return
    }
    openTrace(focusId === 'reverify' ? undefined : focusId)
  }, [focusId, openTrace, trace.findings, trace.accepted])

  const copy = async () => {
    if (await copyText(answerText)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  const save = () =>
    void window.agent.saveText({
      name: safeFileName(view.task.title, 'md'),
      content: traceMarkdown(trace),
      kind: 'markdown',
    })
  const exportEvidence = () =>
    void window.agent.saveText({
      name: safeFileName(`${view.task.title}-evidence`, 'json'),
      content: JSON.stringify(
        {
          task: view.task,
          answer: trace.answer,
          plan: trace.plan,
          events: trace.events,
          findings: trace.findings,
          accepted: trace.accepted,
          resolved: taskTrace.resolved,
          coverage: trace.coverage,
          usage: trace.usage,
        },
        null,
        2,
      ),
      kind: 'json',
    })
  const savePdf = () => {
    setPrinting(true)
    window.dispatchEvent(new Event('sa:prepare-print'))
    setTimeout(() => void window.agent.exportPdf(), 80)
  }
  const loadOlder = async () => {
    setLoadingOlder(true)
    try {
      await onOlder()
    } finally {
      setLoadingOlder(false)
    }
  }
  const chooseModel = (value: string) => {
    if (!onModel) return
    if (!value) {
      onModel(null)
      return
    }
    const local = models.find((model) => model.modelId === value)
    if (local)
      onModel({
        provider: 'compatible',
        modelId: local.modelId,
        baseUrl: local.baseUrl,
        thinking: 'off',
      })
  }

  const markdownComponents = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      const raw = href?.match(/^#ev-(.+)$/)?.[1]
      const item = raw ? resolveEvidence(trace.evidence, decodeURIComponent(raw)) : undefined
      if (item)
        return (
          <button
            className="run-cite"
            type="button"
            title={`${t.runEvidenceTitle} ${item.target}`}
            onClick={() => setPeekId(item.entryId)}
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
  }

  const work = (
    <Work
      activity={activity}
      live={view.live}
      plan={planVisible || workOpen ? trace.plan : null}
      validation={validation}
      open={workOpen || Boolean(view.live) || printing}
      onToggle={() => setWorkOpen((value) => !value)}
      t={t}
      lang={lang}
      taskTitle={view.task.title}
    />
  )

  const answerSection = (
    <section
      className="run-answer"
      aria-label={t.runAnswerTitle}
      aria-live="polite"
      aria-atomic="false"
    >
      {answerText ? (
        <div className="verdict prose run-summary" data-verdict>
          <Suspense fallback={<p>{plain(answerText)}</p>}>
            <Markdown text={answerText} components={markdownComponents} />
          </Suspense>
        </div>
      ) : view.live ? null : (
        <p className="quiet">{t.runNoAnswer}</p>
      )}
      {!stale && (answer?.unresolvedCitations ?? 0) > 0 && (
        <p className="quiet run-unresolved">
          <AlertTriangle size={12} strokeWidth={1.7} aria-hidden="true" />
          {(answer?.unresolvedCitations ?? 0) === 1
            ? t.runUnresolvedCitationsOne
            : fill(t.runUnresolvedCitations, { n: answer?.unresolvedCitations ?? 0 })}
        </p>
      )}
      {!stale && ungrounded.size > 0 && (
        <p className="grounding">
          <AlertTriangle size={12} strokeWidth={1.7} aria-hidden="true" />
          {t.ungroundedNote}
        </p>
      )}
      {!stale && contradicted.size > 0 && (
        <p className="grounding">
          <AlertTriangle size={12} strokeWidth={1.7} aria-hidden="true" />
          {t.contradictedNote}
        </p>
      )}
    </section>
  )

  return (
    <div className="scroll" ref={root}>
      <article className="brief run" data-task-id={view.task.id}>
        <h1 className="visually-hidden">{view.task.title}</h1>

        <header className="run-header">
          <div className="run-headline">
            <p className="run-scope">{scopeText(trace.facts, t)}</p>
            <span className="run-actions">
              {answerText && (
                <button className="text-action" type="button" onClick={() => void copy()}>
                  <Copy size={12} aria-hidden="true" />
                  {copied ? t.copied : t.copyAnswer}
                </button>
              )}
              <div className="brief-more">
                <button
                  className="text-action"
                  type="button"
                  aria-label={t.moreActions}
                  aria-expanded={more}
                  onClick={() => setMore((value) => !value)}
                >
                  <MoreHorizontal size={13} aria-hidden="true" />
                </button>
                {more && (
                  <div className="mini-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMore(false)
                        save()
                      }}
                    >
                      <ArrowDownToLine size={13} aria-hidden="true" />
                      {t.savePage}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={auditing}
                      onClick={() => {
                        setMore(false)
                        onAudit()
                      }}
                    >
                      <Radar size={13} aria-hidden="true" />
                      {auditing || auditProgress ? t.checkingAccount : t.checkAgain}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMore(false)
                        void onReverify()
                      }}
                    >
                      {t.reverify}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={async () => {
                        setMore(false)
                        if (await copyText(`${TASK_LINK_PREFIX}${view.task.id}`)) {
                          setLinked(true)
                          setTimeout(() => setLinked(false), 1500)
                        }
                      }}
                    >
                      <Link2 size={13} aria-hidden="true" />
                      {linked ? t.copied : t.copyLink}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMore(false)
                        exportEvidence()
                      }}
                    >
                      {t.exportEvidence}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMore(false)
                        savePdf()
                      }}
                    >
                      {t.savePdf}
                    </button>
                  </div>
                )}
              </div>
            </span>
          </div>
          {question && <h2 className="run-question">{question}</h2>}
          {(answer?.synthesized || answer?.stale) && (
            <div className="run-facts">
              {answer?.synthesized && <span className="run-tag">{t.runSynthesized}</span>}
              {answer?.stale && <span className="run-tag warn">{t.runStale}</span>}
            </div>
          )}
        </header>

        {view.hasOlder && (
          <button
            className="run-older"
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? t.runLoadingEarlier : t.runLoadEarlier}
          </button>
        )}

        <TurnHistory
          turns={earlierTurns}
          t={t}
          open={historyOpen}
          onToggle={() => setHistoryOpen((value) => !value)}
          selected={selectedTurn}
          onSelect={setSelectedTurn}
        />

        {noticesFirst && (
          <RunNotices
            notices={trace.facts.notices}
            t={t}
            onRetry={onRetry}
            onContinue={onContinue}
          />
        )}

        {clarifyFirst && trace.clarify && (
          <ClarifyCard clarify={trace.clarify} t={t} onClarify={(text) => onClarify?.(text)} />
        )}

        {!noticesFirst && (
          <RunNotices
            notices={trace.facts.notices}
            t={t}
            onRetry={onRetry}
            onContinue={onContinue}
          />
        )}

        {traceFirst ? (
          <>
            {work}
            {answerSection}
          </>
        ) : (
          <>
            {answerSection}
            {work}
          </>
        )}

        {!view.live && !auditProgress && (findingsCount > 0 || notChecked > 0) && (
          <div className="run-evidence-strip">
            {findingsCount > 0 && (
              <button
                className={`run-evidence-button ${findingsOpen ? 'open' : ''}`}
                type="button"
                aria-expanded={findingsOpen}
                onClick={() => {
                  setFindingsOpen((value) => !value)
                  setCoverageOpen(false)
                }}
              >
                <span className="run-section-title">{t.runFindings}</span>
                <span className="run-evidence-count">
                  {trace.findings.length > 0
                    ? trace.findings.length === 1
                      ? t.findingsCountOne
                      : fill(t.findingsCount, { n: trace.findings.length })
                    : trace.accepted.length === 1
                      ? t.acceptedOne
                      : fill(t.acceptedCount, { n: trace.accepted.length })}
                </span>
                <ChevronRight size={13} className={`chev ${findingsOpen ? 'open' : ''}`} />
              </button>
            )}
            {notChecked > 0 && (
              <button
                className={`run-evidence-button ${coverageOpen ? 'open' : ''}`}
                type="button"
                aria-expanded={coverageOpen}
                onClick={() => {
                  setCoverageOpen((value) => !value)
                  setFindingsOpen(false)
                }}
              >
                <span className="run-section-title">{t.runNotChecked}</span>
                <span className="run-evidence-count">{notChecked}</span>
                <ChevronRight size={13} className={`chev ${coverageOpen ? 'open' : ''}`} />
              </button>
            )}
          </div>
        )}

        {!view.live && findingsOpen && (
          <FindingsPanel trace={trace} resolved={taskTrace.resolved} t={t} onOpen={openTrace} />
        )}
        {!view.live && coverageOpen && <CoveragePanel trace={trace} t={t} />}

        {peek?.view && (
          <EvidencePeek
            item={peek}
            t={t}
            lang={lang}
            taskTitle={view.task.title}
            onClose={() => setPeekId(null)}
            onOpen={() => openTrace(peek.entryId)}
          />
        )}

        <footer className="run-meta">
          <div className="run-model">
            <span>{t.model}</span>
            {onModel ? (
              <select
                aria-label={t.model}
                value={view.model?.modelId ?? ''}
                onChange={(event) => chooseModel(event.target.value)}
              >
                <option value="">{t.modelDefault}</option>
                {models.map((model) => (
                  <option key={`${model.source}:${model.modelId}`} value={model.modelId}>
                    {model.source} · {model.modelId}
                  </option>
                ))}
                {view.model && !models.some((model) => model.modelId === view.model?.modelId) && (
                  <option value={view.model.modelId}>{view.model.modelId}</option>
                )}
              </select>
            ) : (
              <span>{view.model?.modelId ?? modelLabel ?? t.noModel}</span>
            )}
          </div>
          <span>
            {activity.calls === 1 ? t.runWorkCallOne : fill(t.runWorkCalls, { n: activity.calls })}
          </span>
          {trace.usage && trace.usage.input + trace.usage.output > 0 && (
            <span>{fill(t.tokens, { n: trace.usage.input + trace.usage.output })}</span>
          )}
          {trace.usage && trace.usage.cost > 0 && <span>${trace.usage.cost.toFixed(4)}</span>}
        </footer>
      </article>
    </div>
  )
}

/** The plain-text answer used by copy. */
export function runMarkdown(trace: RunTrace): string {
  return trace.answer?.text ?? ''
}
