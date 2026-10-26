import type { BriefFinding } from '@shared/brief'
import { readStateOfBrief } from '@shared/brief'
import {
  type AuditProgress,
  type Lang,
  type ReportBlock,
  TASK_LINK_PREFIX,
  type TaskView,
  type ToolView,
} from '@shared/contract'
import { buildRun, type RunEvidence, type RunModel, resolveEvidence } from '@shared/run'
import {
  AlertTriangle,
  ArrowDownToLine,
  Check,
  Circle,
  Copy,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Radar,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Brief, briefMarkdown, FindingRow } from './Brief'
import { type Dict, dict, fill, toolLabel } from './i18n'
import { copyText, safeFileName } from './lib/export'
import { AccessChain, ChartView, PlanView, TableView, ToolViewBody } from './Views'

const Markdown = lazy(() => import('./Markdown'))

function plain(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1')
}

function ago(iso: string, t: Dict): string | null {
  const started = Date.parse(iso)
  if (Number.isNaN(started)) return null
  const seconds = Math.max(0, (Date.now() - started) / 1000)
  if (seconds < 60) return t.justNow
  if (seconds < 3600) return fill(t.minutesAgo, { n: Math.floor(seconds / 60) })
  if (seconds < 86_400) return fill(t.hoursAgo, { n: Math.floor(seconds / 3600) })
  return fill(t.daysAgo, { n: Math.floor(seconds / 86_400) })
}

function source(run: RunModel, block: ReportBlock): RunEvidence | undefined {
  if (!('evidence' in block)) return undefined
  return resolveEvidence(run.evidence, block.evidence[0])
}

function SourceLine({
  run,
  block,
  t,
  lang,
  onOpen,
}: {
  run: RunModel
  block: ReportBlock
  t: Dict
  lang: Lang
  onOpen: (entryId: string) => void
}) {
  const item = source(run, block)
  if (!item) return null
  return (
    <button className="run-source" type="button" onClick={() => onOpen(item.entryId)}>
      {toolLabel(item.name, lang)}
      {item.target ? ` · ${item.target}` : ''}
      <span className="run-source-dot" aria-hidden="true">
        {' '}
      </span>
      {t.runViewEvidence}
    </button>
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
              .filter((cell) => cell !== null && cell !== '')
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
}: {
  run: RunModel
  block: Extract<ReportBlock, { kind: 'findings' }>
  t: Dict
  onOpen: (id: string) => void
  onAccept: (finding: BriefFinding) => void
  staleDays: number
}) {
  const all = run.brief.findings.filter(
    (finding) =>
      (!block.bucket || finding.bucket === block.bucket) &&
      (!block.code || finding.code === block.code) &&
      finding.status === 'open',
  )
  const rows = all.slice(0, block.limit ?? 5)
  if (!rows.length) return <p className="quiet">{t.runNoMatch}</p>
  return (
    <div className="findings-list">
      {rows.map((finding) => (
        <FindingRow
          key={finding.key}
          finding={finding}
          t={t}
          onOpen={() => onOpen(finding.sourceId)}
          onAccept={() => onAccept(finding)}
          tagMemory
          showBucket
          staleDays={staleDays}
        />
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
  const [copied, setCopied] = useState(false)
  const [linked, setLinked] = useState(false)
  const [more, setMore] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const read = readStateOfBrief(run.brief)
  const scopeNames = [...new Set(run.brief.coverage.map((item) => item.provider))]
  const coverageStatus =
    read.open > 0
      ? `${fill(t.scopeOpen, { n: read.open })}${
          read.blocked > 0 ? ` · ${fill(t.scopeBlocked, { n: read.blocked })}` : ''
        }`
      : read.complete
        ? t.scopeComplete
        : ''
  const checked = run.brief.lastReadAt ? ago(run.brief.lastReadAt, t) : null
  const question = run.question?.text ?? view.task.title
  const report = run.report
  const hasSummary = Boolean(report?.blocks.some((block) => block.kind === 'summary'))
  const hasTable = Boolean(
    report?.blocks.some(
      (block) => block.kind === 'table' || block.kind === 'code' || block.kind === 'timeline',
    ),
  )
  const hasPlan = Boolean(report?.blocks.some((block) => block.kind === 'plan'))
  const ungrounded = new Set(report?.ungrounded ?? [])
  const contradicted = new Set(report?.contradicted ?? [])

  useEffect(() => {
    if (focusId !== 'verdict' && focusId !== run.report?.id) return
    const summary = root.current?.querySelector<HTMLElement>('.run-summary')
    if (!summary) return
    summary.scrollIntoView({ block: 'center' })
    summary.classList.add('flash')
    const timer = setTimeout(() => summary.classList.remove('flash'), 1600)
    return () => clearTimeout(timer)
  }, [focusId, run.report?.id])

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

  return (
    <div className="scroll" ref={root}>
      <article className="brief run">
        <h1 className="visually-hidden">{view.task.title}</h1>

        <header className="run-header">
          <div className="run-headline">
            <p className="run-scope">
              {[
                scopeNames.join(' · '),
                coverageStatus,
                read.visible > 0
                  ? fill(t.scopeRead, { read: read.processed, total: read.visible })
                  : '',
                checked ? fill(t.checkedAt, { when: checked }) : '',
              ]
                .filter(Boolean)
                .join(' · ') || t.runNoScope}
            </p>
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
                        void window.agent.exportPdf()
                      }}
                    >
                      {t.savePdf}
                    </button>
                  </div>
                )}
              </div>
            </span>
          </div>
          <h2 className="run-question">{question}</h2>
          <div className="run-facts">
            {run.counts.high > 0 && (
              <span className="run-count high">{fill(t.runHigh, { n: run.counts.high })}</span>
            )}
            {run.counts.medium > 0 && (
              <span className="run-count medium">
                {fill(t.runMedium, { n: run.counts.medium })}
              </span>
            )}
            {run.counts.low > 0 && (
              <span className="run-count low">{fill(t.runLow, { n: run.counts.low })}</span>
            )}
            {report?.synthesized && <span className="run-tag">{t.runSynthesized}</span>}
            {report?.stale && <span className="run-tag warn">{t.runStale}</span>}
            {report && !report.stale && (
              <span className="run-tag quiet">
                {(() => {
                  const n = new Set(
                    report.blocks.flatMap((block) => ('evidence' in block ? block.evidence : [])),
                  ).size
                  return n === 1 ? t.runSourceOne : fill(t.runSources, { n })
                })()}
              </span>
            )}
          </div>
        </header>

        {run.plan && (
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
              {!hasSummary && run.brief.verdict?.text && (
                <p className="verdict prose run-summary">{plain(run.brief.verdict.text)}</p>
              )}
              {report.blocks.map((block, index) => {
                if (block.kind === 'summary')
                  return (
                    <div className="verdict prose run-summary" data-verdict key={index}>
                      <Suspense fallback={<p>{plain(block.text)}</p>}>
                        <Markdown
                          text={block.text}
                          components={{
                            code: ({ children, className }) => {
                              const text = String(children ?? '').trim()
                              const missing = !className && ungrounded.has(text)
                              const wrong = !className && contradicted.has(text)
                              return (
                                <code
                                  className={
                                    [className, missing || wrong ? 'ungrounded' : '']
                                      .filter(Boolean)
                                      .join(' ') || undefined
                                  }
                                  title={
                                    missing
                                      ? t.ungroundedHint
                                      : wrong
                                        ? t.contradictedHint
                                        : undefined
                                  }
                                >
                                  {children}
                                </code>
                              )
                            },
                          }}
                        />
                      </Suspense>
                    </div>
                  )
                if (block.kind === 'callout')
                  return (
                    <div className={`run-callout ${block.tone}`} key={index}>
                      {block.title && <p className="run-callout-title">{block.title}</p>}
                      <p>{plain(block.text)}</p>
                    </div>
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
                      <SourceLine
                        run={run}
                        block={block}
                        t={t}
                        lang={lang}
                        onOpen={setEvidenceFocus}
                      />
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
                      <SourceLine
                        run={run}
                        block={block}
                        t={t}
                        lang={lang}
                        onOpen={setEvidenceFocus}
                      />
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
                        onOpen={(id) => setEvidenceFocus(id)}
                        onAccept={accept}
                        staleDays={staleDays}
                      />
                    </section>
                  )
                if (block.kind === 'plan') {
                  const item = source(run, block)
                  const view = item?.view
                  if (view?.kind !== 'fix' || !view.plan) return null
                  return (
                    <section className="run-block" key={index}>
                      {block.title && <h3 className="run-block-title">{block.title}</h3>}
                      <PlanView plan={view.plan} t={t} />
                      <SourceLine
                        run={run}
                        block={block}
                        t={t}
                        lang={lang}
                        onOpen={setEvidenceFocus}
                      />
                    </section>
                  )
                }
                if (block.kind === 'code') {
                  const item = source(run, block)
                  const view = item?.view
                  if (view?.kind !== 'query') return null
                  return (
                    <section className="run-block" key={index}>
                      {block.title && <h3 className="run-block-title">{block.title}</h3>}
                      <pre className="code">{view.code}</pre>
                      <SourceLine
                        run={run}
                        block={block}
                        t={t}
                        lang={lang}
                        onOpen={setEvidenceFocus}
                      />
                    </section>
                  )
                }
                return null
              })}
              {report.unresolved > 0 && (
                <p className="quiet run-unresolved">
                  {fill(t.runUnresolved, { n: report.unresolved })}
                </p>
              )}
              {ungrounded.size > 0 && (
                <p className="grounding">
                  <AlertTriangle size={12} strokeWidth={1.7} aria-hidden="true" />
                  {t.ungroundedNote}
                </p>
              )}
              {contradicted.size > 0 && (
                <p className="grounding">
                  <AlertTriangle size={12} strokeWidth={1.7} aria-hidden="true" />
                  {t.contradictedNote}
                </p>
              )}
            </>
          ) : (
            <p className="quiet">{t.runNoAnswer}</p>
          )}
        </section>

        <Brief
          view={view}
          lang={lang}
          focusId={evidenceFocus ?? focusId}
          onRetry={onRetry}
          onContinue={onContinue}
          onReverify={onReverify}
          onAudit={onAudit}
          auditing={auditing}
          staleDays={staleDays}
          auditProgress={auditProgress}
          evidenceOnly
          hideFindings={false}
          hideData={hasTable}
          hideFix={hasPlan}
          prefixMarkdown={runMarkdown(run)}
        />
      </article>
    </div>
  )
}

// Keep the report markdown reachable for the window's copy/export path.
export function runMarkdown(run: RunModel): string {
  if (!run.report) return ''
  return run.report.blocks
    .map((block) => {
      if (block.kind === 'summary' || block.kind === 'callout') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}
