import type {
  BriefCheck,
  BriefData,
  BriefFinding,
  BriefFix,
  Brief as BriefModel,
  BriefNotice,
} from '@shared/brief'
import { buildBrief } from '@shared/brief'
import type { Lang, Table, TaskView, ToolName, ToolView, Usage } from '@shared/contract'
import {
  Activity,
  ArrowDownToLine,
  BarChart3,
  ChevronRight,
  Copy,
  Database,
  FileText,
  List,
  Radar,
  Shield,
  StickyNote,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { type Dict, dict, fill, toolLabel } from './i18n'
import { copyText, safeFileName } from './lib/export'
import { ChartView, FixView, TableView, ToolViewBody } from './Views'

const ICONS: Record<ToolName, typeof Radar> = {
  survey: Radar,
  buckets: Database,
  objects: List,
  object: FileText,
  config: Shield,
  probe: Activity,
  estate: StickyNote,
  fix: Wrench,
  analyze: BarChart3,
  note: StickyNote,
}

const FINDINGS_SHOWN = 5

function duration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}

function compact(n: number): string {
  return n < 1000
    ? String(n)
    : n < 1_000_000
      ? `${(n / 1000).toFixed(1)}k`
      : `${(n / 1_000_000).toFixed(1)}M`
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

function severityLabel(finding: BriefFinding, t: Dict): string {
  return finding.severity === 'high'
    ? t.severityHigh
    : finding.severity === 'medium'
      ? t.severityMedium
      : t.severityLow
}

function noticeText(notice: BriefNotice, t: Dict): string {
  const base =
    notice.code === 'stopped'
      ? t.noticeStopped
      : notice.code === 'no_answer'
        ? t.noticeNoAnswer
        : notice.code === 'failed'
          ? t.noticeFailed
          : notice.code === 'budget'
            ? t.noticeBudget
            : notice.code === 'model_missing'
              ? t.noticeModelMissing
              : ''
  if (!base) return notice.text
  return notice.text && notice.code !== 'stopped' ? `${base} ${notice.text}` : base
}

function tableMarkdown(table: Table, limit = 50): string {
  const rows = table.rows.slice(0, limit)
  const head = `| ${table.columns.join(' | ')} |\n| ${table.columns.map(() => '---').join(' | ')} |`
  const body = rows
    .map((row) => `| ${row.map((cell) => (cell === null ? '' : String(cell))).join(' | ')} |`)
    .join('\n')
  return `${head}\n${body}${table.rows.length > rows.length ? '\n\n…' : ''}`
}

function briefMarkdown(title: string, brief: BriefModel, t: Dict, lang: Lang): string {
  const parts: string[] = [`# ${title}`]
  if (brief.verdict?.text) parts.push(brief.verdict.text)
  if (brief.findings.length) {
    parts.push(
      `## ${t.findingsTitle}`,
      brief.findings
        .map(
          (finding) =>
            `- **${finding.bucket}** — ${finding.title} (${severityLabel(finding, t)})${
              finding.detail ? ` · ${finding.detail}` : ''
            }${finding.source === 'memory' ? ` · ${t.remembered}` : ''}`,
        )
        .join('\n'),
    )
  }
  if (brief.accepted.length) {
    parts.push(
      `### ${fill(t.acceptedCount, { n: brief.accepted.length })}`,
      brief.accepted.map((finding) => `- **${finding.bucket}** — ${finding.title}`).join('\n'),
    )
  }
  for (const fix of brief.fixes) {
    const view = fix.view
    parts.push(`## ${t.fixTitle} ${view.bucket}`)
    for (const format of view.formats) {
      parts.push(`### ${format.label}`, `\`\`\`${format.language}\n${format.text}\n\`\`\``)
    }
    parts.push(
      `> ${view.impact.reasons.join(' ')}${view.impact.gap ? ` ${view.impact.gap}` : ''}`.trim(),
    )
  }
  if (brief.data) {
    const view = brief.data.view
    if (view.kind === 'survey') parts.push(`## ${t.buckets}`, tableMarkdown(view.buckets))
    else if (view.kind === 'estate' && view.buckets)
      parts.push(`## ${t.buckets} (${t.remembered})`, tableMarkdown(view.buckets))
    else if (view.kind === 'analyze') parts.push(`## ${view.dataset}`, tableMarkdown(view.rows))
    else if (view.kind === 'buckets' || view.kind === 'objects')
      parts.push(`## ${t.dataTitle}`, tableMarkdown(view.rows))
    else if (view.kind === 'object')
      parts.push(
        `## ${t.dataTitle}`,
        view.facts.map(([key, value]) => `- **${key}**: ${value}`).join('\n'),
      )
  }
  if (brief.checks.length) {
    parts.push(
      `## ${t.checksTitle}`,
      brief.checks
        .map(
          (check) =>
            `- ${toolLabel(check.name, lang)}${check.target ? ` ${check.target}` : ''} — ${
              check.note ?? check.status
            }${check.ms !== null ? ` · ${duration(check.ms)}` : ''}`,
        )
        .join('\n'),
    )
  }
  return `${parts.join('\n\n')}\n`
}

function FindingRow({
  finding,
  t,
  onOpen,
  onAccept,
  tagMemory = true,
}: {
  finding: BriefFinding
  t: Dict
  onOpen: () => void
  onAccept?: () => void
  /** False when every finding is memory and the meta line already says so. */
  tagMemory?: boolean
}) {
  const when = finding.source === 'memory' && tagMemory ? ago(finding.at, t) : null
  return (
    <div
      className="finding-row"
      data-finding-key={finding.key}
      data-source-entry={finding.sourceId}
    >
      <button className="finding-main" type="button" onClick={onOpen}>
        <span className={`sev ${finding.severity}`} aria-hidden="true" />
        <span className="finding-text">
          <span className="finding-title">{finding.title}</span>
          <span className="finding-meta">
            {severityLabel(finding, t)}
            {' · '}
            <span className="mono">{finding.bucket}</span>
            {finding.source === 'memory' && tagMemory && (
              <span className="memory-tag">
                {when ? fill(t.rememberedAgo, { when }) : t.remembered}
              </span>
            )}
            {finding.detail ? ` · ${finding.detail}` : ''}
            {finding.recurred > 0 ? ` · ×${finding.recurred + 1}` : ''}
          </span>
        </span>
        <ChevronRight size={13} className="chev" />
      </button>
      {onAccept && (
        <button className="row-action" type="button" onClick={onAccept}>
          {finding.status === 'accepted' ? t.reopen : t.acceptRisk}
        </button>
      )}
    </div>
  )
}

function Fold({ label, tone, children }: { label: string; tone?: 'ok'; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`fold ${tone ?? ''}`}>
      <button
        className="fold-head"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronRight size={12} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  )
}

function DataSection({ data, t }: { data: BriefData; t: Dict }) {
  const view = data.view
  if (view.kind === 'survey') {
    return (
      <TableView
        table={view.buckets}
        name={`${view.provider}-buckets`}
        empty={t.noBuckets}
        t={t}
        limit={10}
      />
    )
  }
  if (view.kind === 'estate' && view.buckets) {
    return (
      <TableView
        table={view.buckets}
        name="remembered-buckets"
        empty={t.emptyEstate}
        t={t}
        limit={10}
      />
    )
  }
  if (view.kind === 'analyze') {
    return (
      <>
        {view.chart && <ChartView chart={view.chart} />}
        <TableView table={view.rows} name={view.dataset} empty={t.noRows} t={t} limit={10} />
      </>
    )
  }
  if (view.kind === 'buckets' || view.kind === 'objects') {
    return (
      <TableView
        table={view.rows}
        name={view.kind}
        empty={view.kind === 'buckets' ? t.noBuckets : t.noObjects}
        t={t}
        limit={10}
      />
    )
  }
  if (view.kind === 'object') {
    if (view.facts.length === 0) return <p className="view-empty">{t.noRows}</p>
    return (
      <>
        <dl className="facts">
          {view.facts.map(([key, value]) => (
            <div className="fact-row" key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {view.preview && <pre className="code">{view.preview.text}</pre>}
      </>
    )
  }
  return null
}

function bucketCount(n: number, t: Dict): string {
  return `${n} ${n === 1 ? t.bucketsOne : t.bucketsShort}`
}

function dataSummary(data: BriefData, t: Dict): string {
  const view = data.view
  if (view.kind === 'survey') return bucketCount(view.buckets.rows.length, t)
  if (view.kind === 'estate')
    return `${t.memoryData} · ${bucketCount(view.buckets?.rows.length ?? 0, t)}`
  if (view.kind === 'analyze') return view.dataset
  if (view.kind === 'buckets' || view.kind === 'objects')
    return `${view.rows.rows.length} ${t.rows}`
  if (view.kind === 'object')
    return view.facts.find(([key]) => key.toLowerCase() === 'key')?.[1] ?? ''
  return ''
}

function CheckRow({
  check,
  open,
  onToggle,
  lang,
  t,
  taskTitle,
}: {
  check: BriefCheck
  open: boolean
  onToggle: () => void
  lang: Lang
  t: Dict
  taskTitle: string
}) {
  const Icon = ICONS[check.name] ?? Activity
  // Views already rendered on the page (findings, the data table, chart, fixes)
  // do not open again here; the check row is their provenance.
  const inline = check.view
    ? ['buckets', 'objects', 'object', 'estate', 'probe', 'note'].includes(check.view.kind)
    : false
  const expandable = inline && check.status !== 'running'
  const shown = duration(check.ms)
  return (
    <div className={`check-row ${check.status}`} data-check-id={check.id}>
      <button
        className="check-line"
        type="button"
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && onToggle()}
      >
        <Icon
          className={`tool-icon ${check.status === 'running' ? 'pulse-icon' : ''}`}
          size={14}
          strokeWidth={1.6}
          aria-hidden="true"
        />
        <span className="verb">{toolLabel(check.name, lang)}</span>
        {check.target && <span className="target">{check.target}</span>}
        {check.note && <span className="note">{check.note}</span>}
        {shown && <span className="time">{shown}</span>}
        {expandable && <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />}
      </button>
      {open && check.view && (
        <div className="check-body">
          <ToolViewBody view={check.view as ToolView} t={t} taskTitle={taskTitle} />
        </div>
      )}
    </div>
  )
}

function FixSection({
  fixes,
  titleOf,
  t,
}: {
  fixes: BriefFix[]
  titleOf: (fix: BriefFix) => string
  t: Dict
}) {
  const [first, ...rest] = fixes
  if (!first) return null
  return (
    <section className="brief-section" aria-label={t.fixTitle}>
      <h2>
        {t.fixTitle} <span className="section-target mono">{first.view.bucket}</span>
        <span className="section-sub">{titleOf(first)}</span>
      </h2>
      <FixView formats={first.view.formats} impact={first.view.impact} t={t} />
      {rest.length > 0 && (
        <Fold label={fill(t.moreFixes, { n: rest.length })}>
          {rest.map((fix) => (
            <div className="fix-more" key={fix.key}>
              <h3>
                <span className="mono">{fix.view.bucket}</span> · {titleOf(fix)}
              </h3>
              <FixView formats={fix.view.formats} impact={fix.view.impact} t={t} />
            </div>
          ))}
        </Fold>
      )}
    </section>
  )
}

function receipt(brief: BriefModel, usage: Usage | null, t: Dict): string {
  const running = brief.checks.filter((check) => check.status === 'running').length
  if (running > 0) return fill(t.checksRunning, { n: running })
  const parts = [
    brief.checks.length === 1
      ? t.checkOne
      : `${brief.checks.length} ${t.checksTitle.toLowerCase()}`,
  ]
  if (brief.durationMs) parts.push(duration(brief.durationMs) ?? '')
  if (usage) {
    const total = usage.input + usage.output
    if (total > 0) parts.push(fill(t.tokens, { n: compact(total) }))
    if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}`)
  }
  return parts.filter(Boolean).join(' · ')
}

export function Brief({
  view,
  lang,
  focusId,
  onOlder,
  onRetry,
  onContinue,
}: {
  view: TaskView
  lang: Lang
  focusId: string | null
  onOlder: () => void
  onRetry: () => void
  onContinue: () => void
}) {
  const t = dict(lang)
  const brief = useMemo(
    () => buildBrief(view.entries, view.live, view.issueStatus),
    [view.entries, view.live, view.issueStatus],
  )
  const [openChecks, setOpenChecks] = useState(Boolean(view.live))
  const [openCheck, setOpenCheck] = useState<string | null>(null)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [allFindings, setAllFindings] = useState(false)
  const [dataOpen, setDataOpen] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const focused = useRef<string | null>(null)

  useEffect(() => {
    setOpenChecks(Boolean(view.live))
    if (!view.live) setOpenCheck(null)
  }, [view.live])

  const revealCheck = useCallback((id: string) => {
    setOpenChecks(true)
    setOpenCheck(id)
    setTimeout(() => {
      const element = root.current?.querySelector<HTMLElement>(
        `[data-check-id="${CSS.escape(id)}"]`,
      )
      if (!element) return
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      element.classList.add('flash')
      setTimeout(() => element.classList.remove('flash'), 1600)
    }, 40)
  }, [])

  useEffect(() => {
    if (!focusId || focused.current === focusId) return
    focused.current = focusId
    const flash = (element: HTMLElement | null | undefined) => {
      if (!element) return
      element.scrollIntoView({ block: 'center' })
      element.classList.add('flash')
      setTimeout(() => element.classList.remove('flash'), 1600)
    }
    if (focusId === 'verdict') {
      flash(root.current?.querySelector('[data-verdict]'))
      return
    }
    if (focusId.startsWith('f:')) {
      const key = focusId.slice(2)
      if (brief.findings.findIndex((finding) => finding.key === key) >= FINDINGS_SHOWN)
        setAllFindings(true)
      setTimeout(
        () => flash(root.current?.querySelector(`[data-finding-key="${CSS.escape(key)}"]`)),
        40,
      )
      return
    }
    if (brief.questions.some((question) => question.id === focusId)) {
      setQuestionsOpen(true)
      setTimeout(
        () => flash(root.current?.querySelector(`[data-entry-id="${CSS.escape(focusId)}"]`)),
        40,
      )
      return
    }
    if (brief.checks.some((check) => check.id === focusId)) revealCheck(focusId)
  }, [focusId, brief, revealCheck])

  const live = Boolean(view.live)
  const visibleFindings = allFindings ? brief.findings : brief.findings.slice(0, FINDINGS_SHOWN)
  const allMemory =
    brief.findings.length > 0 && brief.findings.every((finding) => finding.source === 'memory')
  const rememberedAt = allMemory
    ? (brief.findings.map((finding) => finding.at).sort()[0] ?? null)
    : null
  const pending = brief.coverage.reduce((n, item) => n + item.pending, 0)
  const unread = new Set(brief.coverage.flatMap((item) => [...item.denied, ...item.unknown])).size
  const gone = brief.coverage.flatMap((item) => item.gone)
  const checked = brief.lastReadAt ? ago(brief.lastReadAt, t) : null
  const title = view.task.title
  const hasContent = Boolean(brief.verdict || brief.findings.length || brief.checks.length)
  const answered = brief.findings.length > 0 || brief.accepted.length > 0
  const dataExpanded = dataOpen ?? !answered
  const ungrounded = new Set(brief.verdict?.ungrounded ?? [])
  const markdown = () => briefMarkdown(title, brief, t, lang)
  const ruleTitle = (fix: BriefFix) =>
    [...brief.findings, ...brief.accepted, ...brief.resolved].find(
      (finding) => finding.bucket === fix.view.bucket && finding.code === fix.view.code,
    )?.title ?? fix.view.code.replace(/_/g, ' ')

  const copy = async () => {
    if (await copyText(markdown())) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const accept = (finding: BriefFinding) =>
    finding.issueId
      ? () => void window.agent.acceptIssue(finding.issueId!, finding.status !== 'accepted')
      : undefined

  return (
    <div className="scroll">
      <article className="brief" ref={root} aria-busy={live}>
        <div className={`brief-meta ${hasContent ? '' : 'silent'}`}>
          <span>
            {checked ? fill(t.checkedAt, { when: checked }) : ''}
            {brief.findings.length > 0 &&
              `${checked ? ' · ' : ''}${fill(t.findingsCount, { n: brief.findings.length })}`}
            {rememberedAt && ` · ${fill(t.rememberedAgo, { when: ago(rememberedAt, t) ?? '' })}`}
          </span>
          {hasContent && (
            <span className="brief-actions">
              <button className="text-action" type="button" onClick={() => void copy()}>
                <Copy size={12} aria-hidden="true" />
                {copied ? t.copied : t.copyBrief}
              </button>
              <button
                className="text-action"
                type="button"
                onClick={() =>
                  void window.agent.saveText({
                    name: safeFileName(title, 'md'),
                    content: markdown(),
                    kind: 'markdown',
                  })
                }
              >
                <ArrowDownToLine size={12} aria-hidden="true" />
                {t.saveBrief}
              </button>
            </span>
          )}
        </div>

        <div aria-live="polite" aria-atomic="false">
          {brief.verdict && (
            <div
              className={`verdict prose ${brief.verdict.streaming ? 'streaming' : ''} ${
                brief.verdict.stale && live ? 'stale' : ''
              }`}
              data-verdict
              title={brief.verdict.stale && live ? t.staleVerdict : undefined}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code: ({ children, className }) => {
                    const text = String(children ?? '')
                    const flagged = !className && ungrounded.has(text.trim())
                    return (
                      <code
                        className={
                          [className, flagged ? 'ungrounded' : ''].filter(Boolean).join(' ') ||
                          undefined
                        }
                        title={flagged ? t.ungroundedHint : undefined}
                      >
                        {children}
                      </code>
                    )
                  },
                }}
              >
                {brief.verdict.text}
              </ReactMarkdown>
            </div>
          )}
          {ungrounded.size > 0 && !brief.verdict?.streaming && (
            <p className="grounding">
              <TriangleAlert size={12} strokeWidth={1.7} aria-hidden="true" />
              {t.ungroundedNote}
            </p>
          )}

          {brief.notices.map((notice) => (
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

        {!live && !brief.verdict && brief.checks.length === 0 && (
          <p className="brief-empty">{t.emptyStream}</p>
        )}

        {(brief.findings.length > 0 || brief.accepted.length > 0 || brief.resolved.length > 0) && (
          <section className="brief-section" aria-label={t.findingsTitle}>
            {brief.findings.length > 0 && <h2>{t.findingsTitle}</h2>}
            <div className="findings-list">
              {visibleFindings.map((finding) => (
                <FindingRow
                  key={finding.key}
                  finding={finding}
                  t={t}
                  onOpen={() => revealCheck(finding.sourceId)}
                  onAccept={accept(finding)}
                  tagMemory={!allMemory}
                />
              ))}
            </div>
            {brief.findings.length > FINDINGS_SHOWN && (
              <button
                className="text-action section-more"
                type="button"
                onClick={() => setAllFindings((value) => !value)}
              >
                {allFindings
                  ? t.less
                  : fill(t.moreRows, { n: brief.findings.length - FINDINGS_SHOWN })}
              </button>
            )}
            {brief.accepted.length > 0 && (
              <Fold
                label={
                  brief.accepted.length === 1
                    ? t.acceptedOne
                    : fill(t.acceptedCount, { n: brief.accepted.length })
                }
              >
                {brief.accepted.map((finding) => (
                  <FindingRow
                    key={finding.key}
                    finding={finding}
                    t={t}
                    onOpen={() => revealCheck(finding.sourceId)}
                    onAccept={accept(finding)}
                  />
                ))}
              </Fold>
            )}
            {brief.resolved.length > 0 && (
              <Fold
                tone="ok"
                label={
                  brief.resolved.length === 1
                    ? t.fixedOne
                    : fill(t.fixedCount, { n: brief.resolved.length })
                }
              >
                {brief.resolved.map((finding) => (
                  <p className="resolved-row" key={finding.key}>
                    <span className="mono">{finding.bucket}</span> · {finding.title}
                  </p>
                ))}
              </Fold>
            )}
          </section>
        )}

        {(unread > 0 || pending > 0 || brief.blind.length > 0 || gone.length > 0) && !live && (
          <section className="brief-section blind-section" aria-label={t.openQuestions}>
            {unread > 0 && (
              <p className="blind">
                <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
                {fill(t.blind, { n: unread })}
              </p>
            )}
            {pending > 0 && (
              <p className="blind">
                <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
                {fill(t.pendingBuckets, { n: pending })}
              </p>
            )}
            {brief.blind.map((item) => (
              <p className="blind" key={item.key}>
                <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
                <span className="mono">{item.bucket}</span> · {item.title}
              </p>
            ))}
            {gone.length > 0 && (
              <p className="quiet">{fill(t.goneBuckets, { names: gone.join(', ') })}</p>
            )}
          </section>
        )}

        {!answered && brief.coverage.length > 0 && unread === 0 && pending === 0 && !live && (
          <section className="brief-section">
            <p className="clean">{t.noFindingsClean}</p>
          </section>
        )}

        <FixSection fixes={brief.fixes} titleOf={ruleTitle} t={t} />

        {brief.data && (
          <section className="brief-section data-section">
            <button
              className="section-head"
              type="button"
              aria-expanded={dataExpanded}
              onClick={() => setDataOpen(!dataExpanded)}
            >
              <span className="section-title">{t.dataTitle}</span>
              <span className="section-target">{dataSummary(brief.data, t)}</span>
              <ChevronRight size={13} className={`chev ${dataExpanded ? 'open' : ''}`} />
            </button>
            {dataExpanded && <DataSection data={brief.data} t={t} />}
          </section>
        )}

        {brief.checks.length > 0 && (
          <section className="checks-section">
            <button
              className="checks-head"
              type="button"
              aria-expanded={openChecks}
              onClick={() => setOpenChecks((value) => !value)}
            >
              <span role="status">{receipt(brief, view.usage, t)}</span>
              <ChevronRight size={13} className={`chev ${openChecks ? 'open' : ''}`} />
            </button>
            {openChecks && (
              <div className="checks-list">
                {brief.checks.map((check) => (
                  <CheckRow
                    key={check.id}
                    check={check}
                    open={openCheck === check.id}
                    onToggle={() => setOpenCheck((id) => (id === check.id ? null : check.id))}
                    lang={lang}
                    t={t}
                    taskTitle={title}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {brief.questions.length > 0 && (
          <section className="questions-section">
            <button
              className="questions-head"
              type="button"
              aria-expanded={questionsOpen}
              onClick={() => setQuestionsOpen((value) => !value)}
            >
              {fill(brief.questions.length === 1 ? t.questionOne : t.questionsCount, {
                n: brief.questions.length,
              })}
              <ChevronRight size={13} className={`chev ${questionsOpen ? 'open' : ''}`} />
            </button>
            {questionsOpen && (
              <div className="questions-list">
                {view.hasOlder && (
                  <button className="text-action" type="button" onClick={onOlder}>
                    {t.older}
                  </button>
                )}
                {brief.questions.map((question) => (
                  <div className="question" key={question.id} data-entry-id={question.id}>
                    <p>{question.text}</p>
                    {question.attachments.length > 0 && (
                      <div className="files">
                        {question.attachments.map((file) => (
                          <span className="file-chip" key={file.name}>
                            <FileText size={11} aria-hidden="true" />
                            {file.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </article>
    </div>
  )
}
