import { buildActivity } from '@shared/activity'
import {
  type AuditProgress,
  type Lang,
  TASK_LINK_PREFIX,
  type TaskView,
  type ToolView,
} from '@shared/contract'
import type { NoticeFact, RiskFact } from '@shared/facts'
import {
  buildRun,
  type RunEvidence,
  type RunModel,
  type RunTurn,
  resolveEvidence,
  turnsOf,
} from '@shared/run'
import {
  AlertTriangle,
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Radar,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Work } from './Activity'
import { type Dict, dict, fill, toolLabel } from './i18n'
import { copyText, safeFileName } from './lib/export'
import { FindingRow, factsMarkdown, noticeText, Sources } from './Sources'
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

function ProofView({
  item,
  t,
  lang,
  taskTitle,
}: {
  item: RunEvidence
  t: Dict
  lang: Lang
  taskTitle: string
}) {
  if (!item.view) return null
  const view = item.view
  return (
    <section className="run-proof">
      <div className="run-proof-head">
        <span className="run-section-title">
          {toolLabel(item.name, lang)} · {item.target}
        </span>
      </div>
      {view.kind === 'change' && view.plan ? (
        <ChangePlanView plan={view.plan} t={t} />
      ) : view.kind === 'estate' && view.history ? (
        <TimelineBlock view={view} limit={8} t={t} />
      ) : (
        <TableBlock view={view} limit={8} t={t} taskTitle={taskTitle} />
      )}
    </section>
  )
}

function RiskList({
  run,
  t,
  onOpen,
  onAccept,
  staleDays,
  expand = false,
}: {
  run: RunModel
  t: Dict
  onOpen: (id: string) => void
  onAccept: (finding: RiskFact) => void
  staleDays: number
  expand?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const all = run.facts.findings.filter((finding) => finding.status === 'open')
  const rows = expand || expanded ? all : all.slice(0, 5)
  if (!rows.length) return <p className="quiet">{t.runNoMatch}</p>
  const allMemory = all.length > 0 && all.every((finding) => finding.source === 'memory')
  const rememberedAt = allMemory
    ? ([...all]
        .map((finding) => finding.readAt)
        .sort()
        .at(-1) ?? null)
    : null
  const navigate = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!target.classList.contains('finding-main')) return
    const list = [...event.currentTarget.querySelectorAll<HTMLElement>('.finding-main')]
    const index = list.indexOf(target)
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      list[Math.min(list.length - 1, index + 1)]?.focus()
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      list[Math.max(0, index - 1)]?.focus()
    } else if (event.key === 'a') {
      const key = target.closest<HTMLElement>('.finding-row')?.dataset.findingKey
      const finding = all.find((item) => item.key === key)
      if (finding) onAccept(finding)
    }
  }
  return (
    <>
      {rememberedAt && (
        <p className="run-block-note">
          {fill(t.rememberedAgo, { when: ago(rememberedAt, t) ?? '' })}
        </p>
      )}
      <div className="findings-list" onKeyDown={navigate}>
        {rows.map((finding) => (
          <FindingRow
            key={finding.key}
            finding={finding}
            t={t}
            onOpen={() => onOpen(finding.sourceId)}
            onAccept={() => onAccept(finding)}
            tagMemory={!allMemory}
            showBucket
            staleDays={staleDays}
          />
        ))}
        {!expand && all.length > rows.length && (
          <button
            className="more-toggle"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(true)}
          >
            {fill(t.moreFindings, { n: all.length - rows.length })}
            <ChevronDown size={13} />
          </button>
        )}
      </div>
    </>
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

function RunNotices({
  notices,
  t,
  onRetry,
  onContinue,
}: {
  notices: NoticeFact[]
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

export function Run({
  view,
  lang,
  focusId,
  onRetry,
  onContinue,
  onReverify,
  onOlder = async () => undefined,
  onAudit = () => undefined,
  auditing = false,
  staleDays = 7,
  auditProgress = null,
}: {
  view: TaskView
  lang: Lang
  focusId: string | null
  onRetry: () => void
  onContinue: () => void
  onReverify: () => Promise<void>
  onOlder?: () => Promise<void>
  onAudit?: () => void
  auditing?: boolean
  staleDays?: number
  auditProgress?: AuditProgress | null
}) {
  const t = dict(lang)
  const run = useMemo(
    () => buildRun(view.entries, view.live, view.issueStatus),
    [view.entries, view.live, view.issueStatus],
  )
  const [evidenceFocus, setEvidenceFocus] = useState<string | null>(null)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [workOpen, setWorkOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [linked, setLinked] = useState(false)
  const [more, setMore] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedTurn, setSelectedTurn] = useState<string | null>(null)
  const turns = useMemo(
    () => turnsOf(view.entries, view.issueStatus),
    [view.entries, view.issueStatus],
  )
  const earlierTurns = useMemo(() => turns.slice(0, -1), [turns])
  const activity = useMemo(() => buildActivity(view.entries, view.live), [view.entries, view.live])
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

  const question = run.audit ? null : (run.question?.text ?? null)
  const answer = run.answer
  const stale = Boolean(answer?.stale)
  const answerText = answer?.text ?? ''
  const ungrounded = new Set(stale ? [] : (answer?.ungrounded ?? []))
  const contradicted = new Set(stale ? [] : (answer?.contradicted ?? []))
  const stopped = run.facts.notices.some((notice) => notice.code === 'stopped')
  const showPlan =
    Boolean(view.live) ||
    stopped ||
    Boolean(run.plan?.steps.some((step) => step.status === 'blocked'))
  const evidenceVisible = Boolean(auditProgress) || evidenceOpen
  const primaryProof = useMemo(() => {
    if (view.live || stale) return null
    for (const match of answerText.matchAll(/#ev-([^)\s"'<>]+)/g)) {
      const item = resolveEvidence(run.evidence, decodeURIComponent(match[1]!))
      if (item?.view) return item
    }
    const data = run.facts.data
    if (data) {
      const item = run.evidence.find((entry) => entry.entryId === data.sourceId)
      if (item?.view) return item
    }
    const change = run.facts.changePlans[0]
    if (change) {
      const item = run.evidence.find((entry) => entry.entryId === change.sourceId)
      if (item?.view) return item
    }
    return null
  }, [view.live, stale, answerText, run.evidence, run.facts.data, run.facts.changePlans])
  const primaryData =
    primaryProof?.view &&
    (primaryProof.view.kind === 'survey' ||
      primaryProof.view.kind === 'query' ||
      primaryProof.view.kind === 'buckets' ||
      primaryProof.view.kind === 'objects' ||
      (primaryProof.view.kind === 'config' && Boolean(primaryProof.view.access)) ||
      (primaryProof.view.kind === 'estate' && Boolean(primaryProof.view.history)))
  const primaryChange = primaryProof?.view?.kind === 'change'
  const primaryRisks =
    !primaryProof && !view.live && !stale && !answer?.synthesized && run.facts.findings.length > 0

  const turnKey = run.question?.id ?? view.task.id
  useEffect(() => {
    if (!turnKey) return
    setEvidenceOpen(false)
    setEvidenceFocus(null)
    setWorkOpen(false)
    setMore(false)
    setHistoryOpen(false)
    setSelectedTurn(null)
  }, [turnKey])

  const openEvidence = useCallback((entryId?: string) => {
    setEvidenceOpen(true)
    if (entryId) setEvidenceFocus(entryId)
    setTimeout(() => {
      const element = entryId
        ? root.current?.querySelector<HTMLElement>(`[data-check-id="${CSS.escape(entryId)}"]`)
        : root.current?.querySelector<HTMLElement>('.run-evidence-wrap')
      element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 40)
  }, [])

  const reverify = async () => {
    await onReverify()
    openEvidence('reverify')
  }

  const accept = (finding: RiskFact) => {
    if (!finding.issueId) return
    void window.agent.acceptIssue(finding.issueId, finding.status !== 'accepted')
  }

  useEffect(() => {
    if (!focusId) return
    if (focusId === 'answer' || focusId === run.answer?.id) {
      openEvidence()
      return
    }
    openEvidence(focusId)
  }, [focusId, run.answer?.id, openEvidence])

  const copy = async () => {
    if (
      await copyText(`${runMarkdown(run)}\n\n${factsMarkdown(view.task.title, run.facts, t, lang)}`)
    ) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  const save = () =>
    void window.agent.saveText({
      name: safeFileName(view.task.title, 'md'),
      content: `${runMarkdown(run)}\n\n${factsMarkdown(view.task.title, run.facts, t, lang)}`,
      kind: 'markdown',
    })
  const exportEvidence = () =>
    void window.agent.saveText({
      name: safeFileName(`${view.task.title}-evidence`, 'json'),
      content: JSON.stringify(
        {
          task: view.task,
          answer: run.answer,
          checks: run.facts.checks,
          findings: run.facts.findings,
          accepted: run.facts.accepted,
          changePlans: run.facts.changePlans,
          coverage: run.facts.coverage,
          reverify: run.facts.reverify,
          changes: run.facts.changes,
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

  const markdownComponents = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      const raw = href?.match(/^#ev-(.+)$/)?.[1]
      const item = raw ? resolveEvidence(run.evidence, decodeURIComponent(raw)) : undefined
      if (item)
        return (
          <button
            className="run-cite"
            type="button"
            title={`${t.runEvidenceTitle} ${item.target}`}
            onClick={() => openEvidence(item.entryId)}
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

  const hideData = Boolean(primaryData)
  const hideChange = primaryChange
  // Work owns the call count; Sources carries evidence categories only. Do not
  // repeat the same receipt in two rows.
  const evidenceCount =
    run.facts.findings.length > 0
      ? run.facts.findings.length === 1
        ? t.findingsCountOne
        : fill(t.findingsCount, { n: run.facts.findings.length })
      : ''

  const hasSources =
    run.facts.findings.length + run.facts.accepted.length > 0 ||
    (!hideData && Boolean(run.facts.data)) ||
    (!hideChange && run.facts.changePlans.length > 0) ||
    run.facts.checks.length > 0 ||
    Boolean(run.facts.reverify) ||
    run.facts.changes.length > 0 ||
    run.facts.methods.length > 0 ||
    run.facts.blind.length > 0 ||
    run.facts.undecided.length > 0 ||
    run.facts.coverage.some(
      (item) =>
        item.pending > 0 ||
        item.denied.length > 0 ||
        item.unknown.length > 0 ||
        item.truncated ||
        item.gone.length > 0,
    )

  return (
    <div className="scroll" ref={root}>
      <article className="brief run">
        <h1 className="visually-hidden">{view.task.title}</h1>

        <header className="run-header">
          <div className="run-headline">
            <p className="run-scope">{scopeText(run.facts, t)}</p>
            <span className="run-actions">
              <button className="text-action" type="button" onClick={() => void copy()}>
                <Copy size={12} aria-hidden="true" />
                {copied ? t.copied : t.copyPage}
              </button>
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
                        void reverify()
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

        <RunNotices notices={run.facts.notices} t={t} onRetry={onRetry} onContinue={onContinue} />

        {showPlan && run.plan && (
          <section className="run-plan" aria-label={t.runPlanTitle}>
            <div className="run-section-head">
              <span className="run-section-title">{t.runPlanTitle}</span>
              <span className="run-section-note">{run.plan.note ?? t.runAgentPlan}</span>
            </div>
            <ol className="run-plan-list">
              {run.plan.steps.map((step, index) => (
                <li key={`${step.title}:${index}`} className={`run-step ${step.status}`}>
                  <span className="run-step-mark" aria-hidden="true">
                    {step.status === 'done' ? (
                      <Check size={12} />
                    ) : step.status === 'blocked' ? (
                      <AlertTriangle size={12} />
                    ) : step.status === 'active' ? (
                      <LoaderCircle size={12} className="pulse-icon" />
                    ) : (
                      <Circle size={9} />
                    )}
                  </span>
                  <span className="run-step-title">{step.title}</span>
                  {step.detail && <span className="run-step-detail">{step.detail}</span>}
                </li>
              ))}
            </ol>
          </section>
        )}

        {view.live && (
          <Work
            activity={activity}
            live={view.live}
            open={workOpen || Boolean(view.live)}
            onToggle={() => setWorkOpen((value) => !value)}
            t={t}
            lang={lang}
            taskTitle={view.task.title}
          />
        )}

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

        {!view.live && (
          <Work
            activity={activity}
            live={null}
            open={workOpen || printing}
            onToggle={() => setWorkOpen((value) => !value)}
            t={t}
            lang={lang}
            taskTitle={view.task.title}
          />
        )}

        {primaryProof?.view && !view.live && (
          <ProofView item={primaryProof} t={t} lang={lang} taskTitle={view.task.title} />
        )}

        {view.live &&
          (!answer || answer.stale) &&
          (view.live.text || view.live.phase === 'writing') && (
            <section className="run-draft" aria-label={t.runDraft}>
              <div className="run-draft-head">
                <span className="run-section-title">{t.runDraft}</span>
                <span className="run-section-note">{t.runDraftNote}</span>
              </div>
              {view.live.text ? (
                <div className="prose run-draft-body">
                  <Suspense fallback={<p>{plain(view.live.text)}</p>}>
                    <Markdown text={view.live.text} components={undefined} />
                  </Suspense>
                </div>
              ) : (
                <p className="quiet">{t.runComposing}</p>
              )}
            </section>
          )}

        {primaryRisks && (
          <section className="run-proof run-primary-risks">
            <div className="run-proof-head">
              <span className="run-section-title">{t.findingsTitle}</span>
            </div>
            <RiskList
              run={run}
              t={t}
              onOpen={openEvidence}
              onAccept={accept}
              staleDays={staleDays}
              expand={printing}
            />
          </section>
        )}

        {!view.live && !auditProgress && hasSources && (
          <button
            className={`run-evidence-toggle ${evidenceOpen ? 'open' : ''}`}
            type="button"
            aria-expanded={evidenceOpen}
            onClick={() => (evidenceOpen ? setEvidenceOpen(false) : openEvidence())}
          >
            <span className="run-section-title">
              {evidenceOpen ? t.runHideEvidence : t.runEvidenceTitle}
            </span>
            {evidenceCount && <span className="run-evidence-count">{evidenceCount}</span>}
            <ChevronRight size={13} className={`chev ${evidenceOpen ? 'open' : ''}`} />
          </button>
        )}

        <div className={`run-evidence-wrap ${evidenceVisible ? '' : 'is-collapsed'}`}>
          <Sources
            key={turnKey}
            view={view}
            lang={lang}
            focusId={evidenceFocus ?? focusId}
            staleDays={staleDays}
            hideData={hideData}
            hideChange={hideChange}
          />
        </div>
      </article>
    </div>
  )
}

/** The plain-text answer used by copy and save. */
export function runMarkdown(run: RunModel): string {
  return run.answer?.text ?? ''
}
