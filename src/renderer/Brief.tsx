import type { BriefCheck, BriefData, BriefFinding, Brief as BriefModel } from '@shared/brief'
import { buildBrief } from '@shared/brief'
import type { Lang, Table, TaskView, ToolName, ToolView } from '@shared/contract'
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

function duration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
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
            }`,
        )
        .join('\n'),
    )
  }
  if (brief.fix) {
    const fix = brief.fix.view
    parts.push(`## ${t.fixTitle} ${fix.bucket}`)
    for (const format of fix.formats) {
      parts.push(`### ${format.label}`, `\`\`\`${format.language}\n${format.text}\n\`\`\``)
    }
    parts.push(
      `> ${fix.impact.reasons.join(' ')}${fix.impact.gap ? ` ${fix.impact.gap}` : ''}`.trim(),
    )
  }
  if (brief.data) {
    const view = brief.data.view
    if (view.kind === 'survey') parts.push(`## ${t.buckets}`, tableMarkdown(view.buckets))
    else if (view.kind === 'analyze') parts.push(`## ${view.dataset}`, tableMarkdown(view.rows))
    else if (view.kind === 'buckets' || view.kind === 'objects')
      parts.push(`## ${t.buckets}`, tableMarkdown(view.rows))
    else if (view.kind === 'object')
      parts.push(
        `## ${t.buckets}`,
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
}: {
  finding: BriefFinding
  t: Dict
  onOpen: () => void
}) {
  return (
    <button
      className="finding-row"
      type="button"
      data-finding-key={finding.key}
      data-source-entry={finding.sourceId}
      onClick={onOpen}
    >
      <span className={`sev ${finding.severity}`} aria-hidden="true" />
      <span className="finding-text">
        <span className="finding-title">{finding.title}</span>
        <span className="finding-meta">
          {severityLabel(finding, t)}
          {' · '}
          {finding.provider ? `${finding.provider} · ` : ''}
          {finding.bucket}
          {finding.detail ? ` · ${finding.detail}` : ''}
        </span>
      </span>
      <ChevronRight size={13} className="chev" />
    </button>
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
        name="objects"
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
  // Views already rendered on the page (the bucket table, findings, chart, fix)
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
  const brief = useMemo(() => buildBrief(view.entries, view.live), [view.entries, view.live])
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
      flash(root.current?.querySelector(`[data-finding-key="${CSS.escape(key)}"]`))
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
    const finding = brief.findings.find((item) => item.sourceId === focusId)
    if (finding) {
      flash(root.current?.querySelector(`[data-finding-key="${CSS.escape(finding.key)}"]`))
      return
    }
    if (brief.checks.some((check) => check.id === focusId)) revealCheck(focusId)
  }, [focusId, brief, revealCheck])

  const live = Boolean(view.live)
  const running = brief.checks.filter((check) => check.status === 'running').length
  const visibleFindings = allFindings ? brief.findings : brief.findings.slice(0, 5)
  const blind = brief.coverage ? brief.coverage.denied.length + brief.coverage.unknown.length : 0
  const checked = brief.lastReadAt ? ago(brief.lastReadAt, t) : null
  const title = view.task.title
  const hasContent = Boolean(brief.verdict || brief.findings.length || brief.checks.length)
  const dataExpanded = dataOpen ?? brief.findings.length === 0
  const dataSummary = brief.data
    ? brief.data.view.kind === 'survey'
      ? `${brief.data.view.buckets.rows.length} ${t.buckets.toLowerCase()}`
      : brief.data.view.kind === 'analyze'
        ? brief.data.view.dataset
        : brief.data.view.kind === 'buckets' || brief.data.view.kind === 'objects'
          ? `${brief.data.view.rows.rows.length} ${t.rows}`
          : brief.data.view.kind === 'object'
            ? (brief.data.view.facts.find(([key]) => key.toLowerCase() === 'key')?.[1] ?? '')
            : ''
    : ''
  const markdown = () => briefMarkdown(title, brief, t, lang)

  const copy = async () => {
    if (await copyText(markdown())) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="scroll">
      <article className="brief" ref={root}>
        <div className={`brief-meta ${hasContent ? '' : 'silent'}`}>
          <span>
            {checked ? fill(t.checkedAt, { when: checked }) : ''}
            {brief.findings.length > 0 &&
              `${checked ? ' · ' : ''}${fill(t.findingsCount, { n: brief.findings.length })}`}
          </span>
          {hasContent && (
            <span className="brief-actions">
              <button className="text-action" type="button" onClick={() => void copy()}>
                <Copy size={12} />
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
                <ArrowDownToLine size={12} />
                {t.saveBrief}
              </button>
            </span>
          )}
        </div>

        {brief.verdict && (
          <div
            className={`verdict prose ${brief.verdict.streaming ? 'streaming' : ''}`}
            data-verdict
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{brief.verdict.text}</ReactMarkdown>
          </div>
        )}

        {brief.notices.map((notice) => (
          <div className={`notice ${notice.tone}`} key={notice.id}>
            <span className="dot" />
            <span className="text">{notice.text}</span>
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

        {!live && !brief.verdict && brief.checks.length === 0 && (
          <p className="brief-empty">{t.emptyStream}</p>
        )}

        {brief.findings.length > 0 && (
          <section className="brief-section">
            <h2>{t.findingsTitle}</h2>
            <div className="findings-list">
              {visibleFindings.map((finding) => (
                <FindingRow
                  key={finding.key}
                  finding={finding}
                  t={t}
                  onOpen={() => revealCheck(finding.sourceId)}
                />
              ))}
            </div>
            {brief.findings.length > 5 && (
              <button
                className="text-action section-more"
                type="button"
                onClick={() => setAllFindings((value) => !value)}
              >
                {allFindings ? t.less : fill(t.moreRows, { n: brief.findings.length - 5 })}
              </button>
            )}
            {blind > 0 && (
              <p className="blind">
                <TriangleAlert size={13} strokeWidth={1.7} />
                {fill(t.blind, { n: blind })}
              </p>
            )}
          </section>
        )}

        {brief.findings.length === 0 && brief.coverage && !live && (
          <section className="brief-section">
            {blind === 0 ? (
              <p className="clean">{t.noFindingsClean}</p>
            ) : (
              <p className="blind">
                <TriangleAlert size={13} strokeWidth={1.7} />
                {fill(t.blind, { n: blind })}
              </p>
            )}
          </section>
        )}

        {brief.fix && (
          <section className="brief-section">
            <h2>
              {t.fixTitle} <span className="section-target">{brief.fix.view.bucket}</span>
            </h2>
            <FixView formats={brief.fix.view.formats} impact={brief.fix.view.impact} t={t} />
          </section>
        )}

        {brief.data && (
          <section className="brief-section data-section">
            <button
              className="section-head"
              type="button"
              aria-expanded={dataExpanded}
              onClick={() => setDataOpen(!dataExpanded)}
            >
              <span className="section-title">{t.dataTitle}</span>
              <span className="section-target">{dataSummary}</span>
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
              <span>
                {running > 0
                  ? `${fill(t.checksRunning, { n: running })}`
                  : `${
                      brief.checks.length === 1
                        ? t.checkOne
                        : `${brief.checks.length} ${t.checksTitle.toLowerCase()}`
                    }${brief.durationMs ? ` · ${duration(brief.durationMs)}` : ''}`}
              </span>
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
                            <FileText size={11} />
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
