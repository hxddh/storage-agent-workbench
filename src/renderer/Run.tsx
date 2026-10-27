import type { BriefData, BriefFinding, BriefNotice } from '@shared/brief'
import {
  type AuditProgress,
  type Lang,
  type ReportBlock,
  TASK_LINK_PREFIX,
  type TaskView,
  type ToolView,
} from '@shared/contract'
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
import { type Dict, dict, fill, toolLabel } from './i18n'
import { copyText, safeFileName } from './lib/export'
import { briefMarkdown, FindingRow, noticeText, Sources } from './Sources'
import { scopeText } from './scope'
import { ago } from './time'
import { AccessChain, ChartView, PlanView, TableView, ToolViewBody } from './Views'

const Markdown = lazy(() => import('./Markdown'))

function plain(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1')
}

function source(run: RunModel, block: ReportBlock): RunEvidence | undefined {
  if (!('evidence' in block)) return undefined
  return resolveEvidence(run.evidence, block.evidence[0])
}

function SourceLine({ run, block, lang }: { run: RunModel; block: ReportBlock; lang: Lang }) {
  const item = source(run, block)
  if (!item) return null
  return (
    <p className="run-source">
      {toolLabel(item.name, lang)}
      {item.target ? ` · ${item.target}` : ''}
    </p>
  )
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
        name="remembered-buckets"
        empty={t.emptyEstate}
        t={t}
        limit={limit ?? 10}
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
      {view.kind === 'fix' && view.plan ? (
        <PlanView plan={view.plan} t={t} />
      ) : view.kind === 'estate' && view.history ? (
        <TimelineBlock view={view} limit={8} t={t} />
      ) : (
        <TableBlock view={view} limit={8} t={t} taskTitle={taskTitle} />
      )}
    </section>
  )
}

function CompareBlock({
  run,
  block,
  t,
  lang,
  taskTitle,
}: {
  run: RunModel
  block: Extract<ReportBlock, { kind: 'compare' }>
  t: Dict
  lang: Lang
  taskTitle: string
}) {
  const items = block.evidence
    .slice(0, 2)
    .map((id) => resolveEvidence(run.evidence, id))
    .filter((item): item is RunEvidence => Boolean(item?.view))
  if (items.length < 2) return null
  return (
    <div className="run-compare">
      {items.map((item) => (
        <section className="run-compare-item" key={item.id}>
          <h4>
            {toolLabel(item.name, lang)} · {item.target}
          </h4>
          <ToolViewBody view={item.view!} t={t} taskTitle={taskTitle} />
        </section>
      ))}
    </div>
  )
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

function FindingsBlock({
  run,
  block,
  t,
  onOpen,
  onAccept,
  staleDays,
  expand = false,
}: {
  run: RunModel
  block: Extract<ReportBlock, { kind: 'findings' }>
  t: Dict
  onOpen: (id: string) => void
  onAccept: (finding: BriefFinding) => void
  staleDays: number
  expand?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const all = run.brief.findings.filter(
    (finding) =>
      (!block.bucket || finding.bucket === block.bucket) &&
      (!block.code || finding.code === block.code) &&
      finding.status === 'open',
  )
  const rows = expand || expanded ? all : all.slice(0, block.limit ?? 5)
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
      {block.title && <h3 className="run-block-title">{block.title}</h3>}
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
            const summary = turn.report?.blocks.find(
              (block) =>
                block.kind === 'summary' || block.kind === 'callout' || block.kind === 'markdown',
            )
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
                      <p className="run-turn-summary">
                        {summary.kind === 'markdown'
                          ? plain(
                              summary.text
                                .replace(/^#{1,6}\s+/gm, '')
                                .replace(/^[-*]\s+/gm, '')
                                .replace(/\s+/g, ' ')
                                .trim(),
                            )
                          : plain(summary.text)}
                      </p>
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
  notices: BriefNotice[]
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

/** The one evidence view that directly answers the question; the rest is in the fold. */
function PrimaryData({ data, t, taskTitle }: { data: BriefData; t: Dict; taskTitle: string }) {
  const view = data.view
  let title = t.dataTitle
  let body: React.ReactNode = null
  if (view.kind === 'survey') {
    title = t.buckets
    body = (
      <TableView
        table={view.buckets}
        name={`${view.provider}-buckets`}
        empty={t.noBuckets}
        t={t}
        limit={3}
      />
    )
  } else if (view.kind === 'config' && view.access) {
    title = t.accessTitle
    body = (
      <AccessChain
        paths={view.access}
        blind={view.accessBlind}
        coverage={view.accessCoverage}
        t={t}
      />
    )
  } else if (view.kind === 'query') {
    body = (
      <>
        {view.chart && <ChartView chart={view.chart} />}
        <TableView table={view.rows} name={view.title} empty={t.noRows} t={t} limit={5} />
      </>
    )
  } else if (view.kind === 'estate' && view.history) {
    title = t.history
    body = <TimelineBlock view={view} limit={5} t={t} />
  } else if (view.kind === 'buckets' || view.kind === 'objects') {
    body = (
      <TableView
        table={view.rows}
        name={taskTitle || view.kind}
        empty={view.kind === 'buckets' ? t.noBuckets : t.noObjects}
        t={t}
        limit={5}
      />
    )
  }
  if (!body) return null
  return (
    <section className="run-preview">
      <div className="run-preview-head">
        <span className="run-section-title">{title}</span>
      </div>
      {body}
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
  const report = run.report
  // Tasks created before the report protocol still carry a durable verdict in
  // their answer entry. The unified Run shows that answer instead of sending
  // the task back to a second page.
  const legacyVerdict = !report && !view.live ? run.brief.verdict : null
  const stale = Boolean(report?.stale)
  // A stale report belongs to the previous question. Keep its prose as context,
  // but do not let its tables or plan masquerade as the current answer.
  const visibleBlocks = report
    ? stale
      ? report.blocks.filter((block) => block.kind === 'summary' || block.kind === 'callout')
      : report.blocks
    : []
  const hasSummary = visibleBlocks.some((block) => block.kind === 'summary')
  const hasReportTable = visibleBlocks.some((block) => block.kind === 'table')
  const hasReportTimeline = visibleBlocks.some((block) => block.kind === 'timeline')
  const hasReportCode = visibleBlocks.some((block) => block.kind === 'code')
  const hasReportPlan = visibleBlocks.some((block) => block.kind === 'plan')
  const hasReportFindings = visibleBlocks.some((block) => block.kind === 'findings')
  const hasReportMarkdown = visibleBlocks.some((block) => block.kind === 'markdown')
  const reportText = report?.text ?? ''
  const reportShow = stale ? [] : (report?.show ?? [])
  const reportEvidence = reportShow
    .map((id) => resolveEvidence(run.evidence, id))
    .filter((item): item is RunEvidence => Boolean(item?.view))
  const proofHasData = reportEvidence.some((item) => {
    const kind = item.view?.kind
    return (
      kind === 'survey' ||
      kind === 'query' ||
      kind === 'buckets' ||
      kind === 'objects' ||
      (kind === 'config' && Boolean(item.view?.access)) ||
      (kind === 'estate' && Boolean(item.view?.history))
    )
  })
  const proofHasFix = reportEvidence.some((item) => item.view?.kind === 'fix')
  const legacyFindings = Boolean(legacyVerdict && run.brief.findings.length)
  const primaryFindings =
    !reportShow.length &&
    !hasReportFindings &&
    !view.live &&
    !stale &&
    !legacyFindings &&
    run.brief.findings.length > 0
  const ungrounded = new Set(stale ? [] : (report?.ungrounded ?? []))
  const contradicted = new Set(stale ? [] : (report?.contradicted ?? []))
  const stopped = run.brief.notices.some((notice) => notice.code === 'stopped')
  const showPlan =
    Boolean(view.live) ||
    stopped ||
    Boolean(run.plan?.steps.some((step) => step.status === 'blocked'))
  const evidenceVisible = Boolean(auditProgress) || evidenceOpen
  // The agent's report is the answer. When it did not compose the proof itself,
  // the latest data read is the one view that can stand beside the summary.
  const primaryData = useMemo(() => {
    if (view.live || stale || reportShow.length > 0) return null
    if (hasReportTable || hasReportTimeline || hasReportFindings || hasReportPlan) return null
    const data = run.brief.data
    if (!data) return null
    const kind = data.view.kind
    if (kind === 'survey' || kind === 'query' || kind === 'buckets' || kind === 'objects')
      return data
    if (kind === 'config' && data.view.access) return data
    if (kind === 'estate' && data.view.history) return data
    return null
  }, [
    view.live,
    stale,
    hasReportTable,
    hasReportTimeline,
    hasReportFindings,
    hasReportPlan,
    reportShow.length,
    run.brief.data,
  ])

  const turnKey = run.question?.id ?? view.task.id
  useEffect(() => {
    if (!turnKey) return
    setEvidenceOpen(false)
    setEvidenceFocus(null)
    setMore(false)
    setHistoryOpen(false)
    setSelectedTurn(null)
  }, [turnKey])

  const loadOlder = async () => {
    setLoadingOlder(true)
    try {
      await onOlder()
    } finally {
      setLoadingOlder(false)
    }
  }

  const openEvidence = useCallback((entryId?: string) => {
    setEvidenceOpen(true)
    if (entryId) setEvidenceFocus(entryId)
    window.setTimeout(() => {
      const target = entryId
        ? root.current?.querySelector<HTMLElement>(`[data-check-id="${CSS.escape(entryId)}"]`)
        : root.current?.querySelector<HTMLElement>('.run-evidence-wrap')
      target?.scrollIntoView({ block: 'center' })
    }, 40)
  }, [])

  const reverify = async () => {
    await onReverify()
    openEvidence('reverify')
  }

  useEffect(() => {
    if (!focusId) return
    const prior = earlierTurns.find((turn) => turn.question?.id === focusId)
    if (prior) {
      setHistoryOpen(true)
      setSelectedTurn(prior.id)
      return
    }
    if (focusId === 'verdict' || focusId === run.report?.id) {
      const summary = root.current?.querySelector<HTMLElement>('.run-summary')
      if (!summary) return
      summary.scrollIntoView({ block: 'center' })
      summary.classList.add('flash')
      const timer = setTimeout(() => summary.classList.remove('flash'), 1600)
      return () => clearTimeout(timer)
    }
    // A search hit on the request is a highlight, not a reason to open the
    // evidence fold. Findings and tool checks do open it.
    if (run.brief.questions.some((item) => item.id === focusId)) return
    openEvidence(focusId)
  }, [focusId, run.report?.id, openEvidence, run.brief.questions, earlierTurns])

  const accept = (finding: BriefFinding) => {
    if (finding.issueId)
      void window.agent.acceptIssue(finding.issueId, finding.status !== 'accepted')
  }

  const fullMarkdown = () =>
    [runMarkdown(run), briefMarkdown(view.task.title, run.brief, t, lang)]
      .filter(Boolean)
      .join('\n\n')

  const copy = async () => {
    if (await copyText(fullMarkdown())) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const save = () =>
    void window.agent.saveText({
      name: safeFileName(view.task.title, 'md'),
      content: fullMarkdown(),
      kind: 'markdown',
    })

  const savePdf = () => {
    setPrinting(true)
    window.dispatchEvent(new Event('sa:prepare-print'))
    window.setTimeout(() => void window.agent.exportPdf(), 80)
  }

  const exportEvidence = () =>
    void window.agent.saveText({
      name: safeFileName(`${view.task.title}-evidence`, 'json'),
      content: JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          task: view.task,
          report: run.report,
          brief: run.brief,
        },
        null,
        2,
      ),
      kind: 'json',
    })

  const markdownComponents = (evidence: string[]) => ({
    code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
      const text = String(children ?? '').trim()
      const missing = !className && ungrounded.has(text)
      const wrong = !className && contradicted.has(text)
      return (
        <code
          className={
            [className, missing || wrong ? 'ungrounded' : ''].filter(Boolean).join(' ') || undefined
          }
          title={missing ? t.ungroundedHint : wrong ? t.contradictedHint : undefined}
        >
          {children}
        </code>
      )
    },
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      const match = /^#ev-(\d+)$/.exec(href ?? '')
      const id = match ? evidence[Number(match[1]) - 1] : undefined
      const item = resolveEvidence(run.evidence, id)
      if (item)
        return (
          <button
            className="run-cite"
            type="button"
            title={`${t.runEvidenceTitle} ${match?.[1]}`}
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
  })

  const hideData =
    Boolean(primaryData) ||
    hasReportTable ||
    hasReportTimeline ||
    hasReportPlan ||
    hasReportCode ||
    proofHasData
  const hideFix = hasReportPlan || proofHasFix
  const hasSources =
    run.brief.findings.length + run.brief.accepted.length > 0 ||
    (!hideData && Boolean(run.brief.data)) ||
    (!hideFix && run.brief.fixes.length > 0) ||
    run.brief.checks.length > 0 ||
    Boolean(run.brief.reverify) ||
    run.brief.changes.length > 0 ||
    run.brief.methods.length > 0 ||
    run.brief.blind.length > 0 ||
    run.brief.undecided.length > 0 ||
    run.brief.coverage.some(
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
            <p className="run-scope">{scopeText(run.brief, t)}</p>
            <span className="run-actions">
              <button className="text-action" type="button" onClick={() => void copy()}>
                <Copy size={12} aria-hidden="true" />
                {copied ? t.copied : t.copyBrief}
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
                      {t.saveBrief}
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
          {(report?.synthesized || report?.stale) && (
            <div className="run-facts">
              {report?.synthesized && <span className="run-tag">{t.runSynthesized}</span>}
              {report?.stale && <span className="run-tag warn">{t.runStale}</span>}
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

        <RunNotices notices={run.brief.notices} t={t} onRetry={onRetry} onContinue={onContinue} />

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

        <section
          className="run-answer"
          aria-label={t.runAnswerTitle}
          aria-live="polite"
          aria-atomic="false"
        >
          {report ? (
            <>
              {reportText ? (
                <>
                  <div className="verdict prose run-summary" data-verdict>
                    <Suspense fallback={<p>{plain(reportText)}</p>}>
                      <Markdown text={reportText} components={markdownComponents(reportShow)} />
                    </Suspense>
                  </div>
                  {reportEvidence.map((item) => (
                    <ProofView
                      key={`${item.id}:${item.entryId}`}
                      item={item}
                      t={t}
                      lang={lang}
                      taskTitle={view.task.title}
                    />
                  ))}
                </>
              ) : null}
              {!reportText && !hasSummary && !hasReportMarkdown && run.brief.verdict?.text && (
                <p className="verdict prose run-summary">{plain(run.brief.verdict.text)}</p>
              )}
              {!reportText &&
                visibleBlocks.map((block, index) => {
                  if (block.kind === 'summary')
                    return (
                      <div className="verdict prose run-summary" data-verdict key={index}>
                        <Suspense fallback={<p>{plain(block.text)}</p>}>
                          <Markdown
                            text={block.text}
                            components={markdownComponents(block.evidence)}
                          />
                        </Suspense>
                      </div>
                    )
                  if (block.kind === 'callout')
                    return (
                      <div className={`run-callout ${block.tone}`} key={index}>
                        {block.title && <p className="run-callout-title">{block.title}</p>}
                        <div className="prose">
                          <Suspense fallback={<p>{plain(block.text)}</p>}>
                            <Markdown
                              text={block.text}
                              components={markdownComponents(block.evidence)}
                            />
                          </Suspense>
                        </div>
                      </div>
                    )
                  if (block.kind === 'markdown')
                    return (
                      <section className="run-block" key={index}>
                        {block.title && <h3 className="run-block-title">{block.title}</h3>}
                        <div className="prose run-markdown">
                          <Suspense fallback={<p>{plain(block.text)}</p>}>
                            <Markdown
                              text={block.text}
                              components={markdownComponents(block.evidence)}
                            />
                          </Suspense>
                        </div>
                        <SourceLine run={run} block={block} lang={lang} />
                      </section>
                    )
                  if (block.kind === 'compare')
                    return (
                      <section className="run-block" key={index}>
                        {block.title && <h3 className="run-block-title">{block.title}</h3>}
                        <CompareBlock
                          run={run}
                          block={block}
                          t={t}
                          lang={lang}
                          taskTitle={view.task.title}
                        />
                      </section>
                    )
                  if (block.kind === 'table') {
                    const item = source(run, block)
                    if (!item?.view) return null
                    return (
                      <section className="run-block" key={index}>
                        {block.title && <h3 className="run-block-title">{block.title}</h3>}
                        <TableBlock
                          view={item.view}
                          limit={block.limit}
                          t={t}
                          taskTitle={view.task.title}
                        />
                        <SourceLine run={run} block={block} lang={lang} />
                      </section>
                    )
                  }
                  if (block.kind === 'timeline') {
                    const item = source(run, block)
                    if (!item?.view) return null
                    return (
                      <section className="run-block" key={index}>
                        {block.title && <h3 className="run-block-title">{block.title}</h3>}
                        <TimelineBlock view={item.view} limit={block.limit} t={t} />
                        <SourceLine run={run} block={block} lang={lang} />
                      </section>
                    )
                  }
                  if (block.kind === 'findings')
                    return (
                      <section className="run-block" key={index}>
                        <FindingsBlock
                          run={run}
                          block={block}
                          t={t}
                          onOpen={openEvidence}
                          onAccept={accept}
                          staleDays={staleDays}
                          expand={printing}
                        />
                      </section>
                    )
                  if (block.kind === 'plan') {
                    const item = source(run, block)
                    const planView = item?.view
                    if (planView?.kind !== 'fix' || !planView.plan) return null
                    return (
                      <section className="run-block" key={index}>
                        {block.title && <h3 className="run-block-title">{block.title}</h3>}
                        <PlanView plan={planView.plan} t={t} />
                        <SourceLine run={run} block={block} lang={lang} />
                      </section>
                    )
                  }
                  if (block.kind === 'code') {
                    const item = source(run, block)
                    const codeView = item?.view
                    if (codeView?.kind !== 'query') return null
                    return (
                      <section className="run-block" key={index}>
                        {block.title && <h3 className="run-block-title">{block.title}</h3>}
                        <pre className="code">{codeView.code}</pre>
                        <SourceLine run={run} block={block} lang={lang} />
                      </section>
                    )
                  }
                  return null
                })}
              {!stale && report.unresolved > 0 && (
                <p className="quiet run-unresolved">
                  {report.unresolved === 1
                    ? t.runUnresolvedOne
                    : fill(t.runUnresolved, { n: report.unresolved })}
                </p>
              )}
              {!stale && report.unresolvedCitations > 0 && (
                <p className="quiet run-unresolved">
                  <AlertTriangle size={12} strokeWidth={1.7} aria-hidden="true" />
                  {report.unresolvedCitations === 1
                    ? t.runUnresolvedCitationsOne
                    : fill(t.runUnresolvedCitations, { n: report.unresolvedCitations })}
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
            </>
          ) : view.live ? null : legacyVerdict ? (
            <>
              <p className="verdict prose run-summary" data-verdict>
                {plain(legacyVerdict.text)}
              </p>
              {legacyFindings && (
                <FindingsBlock
                  run={run}
                  block={{ kind: 'findings', limit: 5 }}
                  t={t}
                  onOpen={openEvidence}
                  onAccept={accept}
                  staleDays={staleDays}
                  expand={printing}
                />
              )}
            </>
          ) : (
            <p className="quiet">{t.runNoAnswer}</p>
          )}
        </section>

        {view.live &&
          (!report || report.stale) &&
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

        {primaryData && !view.live && (
          <PrimaryData data={primaryData} t={t} taskTitle={view.task.title} />
        )}

        {primaryFindings && (
          <section className="run-proof run-primary-risks">
            <div className="run-proof-head">
              <span className="run-section-title">{t.findingsTitle}</span>
            </div>
            <FindingsBlock
              run={run}
              block={{ kind: 'findings', limit: 5 }}
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
            hideFix={hideFix}
          />
        </div>
      </article>
    </div>
  )
}

// Keep the report markdown reachable for the window's copy/export path.
export function runMarkdown(run: RunModel): string {
  if (!run.report) return ''
  return [
    run.report.text,
    ...run.report.blocks.map((block) => {
      if (block.kind === 'summary' || block.kind === 'callout' || block.kind === 'markdown')
        return block.text
      return ''
    }),
  ]
    .filter(Boolean)
    .join('\n\n')
}
