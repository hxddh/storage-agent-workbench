import type {
  BriefCheck,
  BriefData,
  BriefFinding,
  BriefFix,
  Brief as BriefModel,
  BriefNotice,
} from '@shared/brief'
import { buildBrief, readStateOfBrief } from '@shared/brief'
import type { AuditProgress } from '@shared/contract'
import {
  type Lang,
  TASK_LINK_PREFIX,
  type Table,
  type TaskView,
  type ToolName,
  type ToolView,
  type Usage,
} from '@shared/contract'
import {
  Activity,
  ArrowDownToLine,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Database,
  FileText,
  Link2,
  List,
  ListChecks,
  MoreHorizontal,
  Radar,
  Shield,
  StickyNote,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type Dict, dict, fill, toolLabel } from './i18n'
import { copyText, safeFileName } from './lib/export'
import { scopeText } from './scope'
import { ago } from './time'
import {
  AccessChain,
  ChartView,
  FixView,
  humanBytes,
  PlanView,
  planSummary,
  TableView,
  ToolViewBody,
} from './Views'

// Markdown is most of the renderer bundle and is only needed once an answer streams.
const Markdown = lazy(() => import('./Markdown'))

const ICONS: Record<ToolName, typeof Radar> = {
  survey: Radar,
  buckets: Database,
  objects: List,
  object: FileText,
  config: Shield,
  probe: Activity,
  estate: StickyNote,
  fix: Wrench,
  note: StickyNote,
  query: Code2,
  playbook: BookOpen,
  plan: ListChecks,
  report: FileText,
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

const FIELD_ZH: Record<string, string> = {
  'public exposure': '公开访问',
  encryption: '加密',
  'public access block': '阻止公共访问',
  'bucket policy': '存储桶策略',
  ACL: 'ACL',
  CORS: 'CORS',
  'access logging': '访问日志',
  versioning: '版本控制',
  lifecycle: '生命周期',
  'object ownership': '对象所有权',
}

function changeField(field: string, lang: Lang): string {
  return lang === 'zh' ? (FIELD_ZH[field] ?? field) : field
}

function stateLabel(value: 'open' | 'accepted' | 'clear' | 'undecided', t: Dict): string {
  return value === 'open'
    ? t.stateOpen
    : value === 'accepted'
      ? t.stateAccepted
      : value === 'clear'
        ? t.stateClear
        : t.stateUndecided
}

function severityLabel(finding: BriefFinding, t: Dict): string {
  return finding.severity === 'high'
    ? t.severityHigh
    : finding.severity === 'medium'
      ? t.severityMedium
      : t.severityLow
}

export function noticeText(notice: BriefNotice, t: Dict): string {
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

/** A lazy Markdown chunk must not flash raw backticks before it loads. */
function plainVerdict(text: string): string {
  return text.replace(/`/g, '')
}

function tableMarkdown(table: Table, limit = 50): string {
  const rows = table.rows.slice(0, limit)
  const head = `| ${table.columns.join(' | ')} |\n| ${table.columns.map(() => '---').join(' | ')} |`
  const body = rows
    .map((row) => `| ${row.map((cell) => (cell === null ? '' : String(cell))).join(' | ')} |`)
    .join('\n')
  return `${head}\n${body}${table.rows.length > rows.length ? '\n\n…' : ''}`
}

export function briefMarkdown(title: string, brief: BriefModel, t: Dict, lang: Lang): string {
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
  const plan = brief.fixes.find((fix) => fix.view.plan)?.view.plan
  if (plan) {
    parts.push(`## ${t.planTitle}`, planSummary(plan, t))
    if (plan.baseline) {
      parts.push(`> ${fill(t.planBaseline, { when: new Date(plan.baseline.at).toLocaleString() })}`)
    } else {
      parts.push(`> ${t.planNoBaseline}`)
    }
    for (const step of plan.steps) {
      parts.push(
        `### ${step.bucket || t.accountWide} — ${step.title}`,
        `${
          step.status === 'ready' ? t.planStatusReady : t.planStatusManual
        }${step.blockers.length ? ` · ${step.blockers.join(' ')}` : ''}`,
      )
      for (const format of step.formats) {
        parts.push(`#### ${format.label}`, `\`\`\`${format.language}\n${format.text}\n\`\`\``)
      }
      parts.push(
        `> ${step.impact.reasons.join(' ')}${step.impact.gap ? ` ${step.impact.gap}` : ''}`.trim(),
      )
    }
    if (plan.residual.length) {
      parts.push(
        `### ${t.planResidual}`,
        plan.residual
          .map((item) => `- **${item.bucket || t.accountWide}** — ${item.title}`)
          .join('\n'),
      )
    }
  } else {
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
  }
  if (brief.data) {
    const view = brief.data.view
    if (view.kind === 'query')
      parts.push(`## ${view.title}`, tableMarkdown(view.rows), `\`\`\`js\n${view.code}\n\`\`\``)
    else if (view.kind === 'survey') parts.push(`## ${t.buckets}`, tableMarkdown(view.buckets))
    else if (view.kind === 'estate' && view.buckets) {
      parts.push(`## ${t.buckets} (${t.remembered})`, tableMarkdown(view.buckets))
      if (view.history?.rows.length) parts.push(`## ${t.history}`, tableMarkdown(view.history))
    } else if (view.kind === 'buckets' || view.kind === 'objects')
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

export function FindingRow({
  finding,
  t,
  onOpen,
  onAccept,
  tagMemory = true,
  showBucket = true,
  staleDays = 7,
}: {
  finding: BriefFinding
  t: Dict
  onOpen: () => void
  onAccept?: () => void
  /** False when every finding is memory and the meta line already says so. */
  tagMemory?: boolean
  /** The bucket is already the group heading. */
  showBucket?: boolean
  staleDays?: number
}) {
  const when = finding.source === 'memory' && tagMemory ? ago(finding.readAt, t) : null
  const stale =
    finding.source === 'memory' &&
    Number.isFinite(Date.parse(finding.readAt)) &&
    Date.now() - Date.parse(finding.readAt) > staleDays * 86_400_000
  return (
    <div
      className="finding-row"
      data-finding-key={finding.key}
      data-source-entry={finding.sourceId}
      draggable
      onDragStart={(event) => {
        const text = `- **${finding.bucket || 'account'}** — ${finding.title}${
          finding.detail ? `: ${finding.detail}` : ''
        }${finding.control ? ` (${finding.control})` : ''}`
        event.dataTransfer.setData('text/markdown', text)
        event.dataTransfer.setData('text/plain', text)
        event.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <button className="finding-main" type="button" onClick={onOpen}>
        <span className={`sev ${finding.severity}`} aria-hidden="true" />
        <span className="finding-text">
          <span className="finding-title">{finding.title}</span>
          <span className="finding-meta">
            {severityLabel(finding, t)}
            {finding.control ? ` · ${finding.control}` : ''}
            {showBucket && (
              <>
                {' · '}
                {finding.bucket ? <span className="mono">{finding.bucket}</span> : t.accountWide}
              </>
            )}
            {finding.source === 'memory' && tagMemory && (
              <span className="memory-tag">
                {when ? fill(t.rememberedAgo, { when }) : t.remembered}
                {stale ? ` · ${t.possiblyStale}` : ''}
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
  if (view.kind === 'query') {
    const coverage = view.coverage
    const showCoverage = Boolean(
      coverage &&
        (coverage.bucketsExamined !== undefined ||
          coverage.truncated ||
          coverage.principals > 0 ||
          coverage.sources.includes('iam') ||
          coverage.sources.includes('SCP')),
    )
    return (
      <>
        {view.chart && <ChartView chart={view.chart} />}
        <TableView table={view.rows} name={view.title} empty={t.noRows} t={t} limit={10} />
        <p className="quiet">
          {fill(view.calls === 1 ? t.queryReceiptOne : t.queryReceipt, {
            calls: view.calls,
            items: view.listed.toLocaleString(),
          })}
        </p>
        {showCoverage && coverage && (
          <p className="quiet">
            {coverage.bucketsExamined !== undefined && coverage.bucketsTotal !== undefined
              ? fill(t.bucketsExamined, {
                  examined: coverage.bucketsExamined,
                  total: coverage.bucketsTotal,
                })
              : coverage.principals > 0 ||
                  coverage.sources.includes('iam') ||
                  coverage.sources.includes('SCP')
                ? t.accessCoverage(
                    coverage.evaluated,
                    coverage.principals,
                    coverage.undecided,
                    coverage.truncated,
                  )
                : t.truncated}
          </p>
        )}
        {view.blind?.map((item) => (
          <p className="blind" key={`${item.source}:${item.status}`}>
            <TriangleAlert size={12} strokeWidth={1.7} aria-hidden="true" />
            {item.source} · {item.status}
          </p>
        ))}
      </>
    )
  }
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
      <>
        <TableView
          table={view.buckets}
          name="remembered-buckets"
          empty={t.emptyEstate}
          t={t}
          limit={10}
        />
        {view.history && view.history.rows.length > 0 && (
          <div className="history-table">
            <h3 className="history-title">{t.history}</h3>
            <TableView table={view.history} name="history" empty={t.noRows} t={t} limit={10} />
          </div>
        )}
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
  if (view.kind === 'config' && view.access) {
    return (
      <AccessChain
        paths={view.access}
        blind={view.accessBlind}
        coverage={view.accessCoverage}
        t={t}
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
  if (view.kind === 'query') return view.title
  if (view.kind === 'survey')
    return [
      bucketCount(view.buckets.rows.length, t),
      ...(view.capacity
        ? [
            humanBytes(view.capacity.bytes),
            fill(t.perMonth, { usd: `$${view.capacity.monthlyUsd.toLocaleString()}` }),
          ]
        : []),
    ].join(' · ')
  if (view.kind === 'estate')
    return `${t.memoryData} · ${bucketCount(view.buckets?.rows.length ?? 0, t)}`
  if (view.kind === 'buckets' || view.kind === 'objects')
    return `${view.rows.rows.length} ${t.rows}`
  if (view.kind === 'object')
    return view.facts.find(([key]) => key.toLowerCase() === 'key')?.[1] ?? ''
  if (view.kind === 'config') {
    const count = view.access?.length ?? 0
    return `${count} ${count === 1 ? t.accessPathOne : t.accessPaths}${view.accessBlind?.length ? ` · ${t.blindShort}` : ''}`
  }
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
    ? // A query's rows are on the page; its script, the evidence, opens here.
      ['buckets', 'objects', 'object', 'estate', 'probe', 'note', 'query'].includes(check.view.kind)
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
  const plan = fixes.find((fix) => fix.view.plan)?.view.plan
  if (plan) {
    return (
      <section className="brief-section" aria-label={t.planTitle}>
        <h2>{t.planTitle}</h2>
        <PlanView plan={plan} t={t} />
      </section>
    )
  }
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
  onRetry,
  onContinue,
  onReverify,
  onAudit = () => undefined,
  auditing = false,
  staleDays = 7,
  auditProgress = null,
  evidenceOnly = false,
  hideFindings = false,
  hideData = false,
  hideFix = false,
  hideNotices = false,
  hideVerdict = false,
  prefixMarkdown = '',
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
  /** Render only findings, changes, not-read, data and checks; the run header owns the rest. */
  evidenceOnly?: boolean
  hideFindings?: boolean
  hideData?: boolean
  hideFix?: boolean
  hideNotices?: boolean
  hideVerdict?: boolean
  /** Markdown the run composed above this evidence body; included in Copy. */
  prefixMarkdown?: string
}) {
  const t = dict(lang)
  const brief = useMemo(
    () => buildBrief(view.entries, view.live, view.issueStatus),
    [view.entries, view.live, view.issueStatus],
  )
  const [openChecks, setOpenChecks] = useState(Boolean(view.live))
  const [openCheck, setOpenCheck] = useState<string | null>(null)
  const [allFindings, setAllFindings] = useState(false)
  const [dataOpen, setDataOpen] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const [linked, setLinked] = useState(false)
  const [reverifying, setReverifying] = useState(false)
  const [reverifyError, setReverifyError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const focused = useRef<string | null>(null)

  useEffect(() => {
    if (!more) return
    const close = () => setMore(false)
    const timer = setTimeout(() => window.addEventListener('click', close, { once: true }), 0)
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMore(false)
      }
    }
    window.addEventListener('keydown', key)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', key)
    }
  }, [more])

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
      const rest = focusId.slice(2)
      const key = rest.slice(rest.indexOf(':') + 1)
      if (brief.findings.findIndex((finding) => finding.key === key) >= FINDINGS_SHOWN)
        setAllFindings(true)
      setTimeout(
        () => flash(root.current?.querySelector(`[data-finding-key="${CSS.escape(key)}"]`)),
        40,
      )
      return
    }
    if (brief.questions.some((question) => question.id === focusId)) {
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
  const findingGroups = [
    ...new Map(
      visibleFindings.map((finding) => [
        finding.bucket || '',
        { bucket: finding.bucket, items: [] as BriefFinding[] },
      ]),
    ).values(),
  ]
  for (const finding of visibleFindings) {
    const group = findingGroups.find((item) => item.bucket === finding.bucket)
    group?.items.push(finding)
  }
  const allMemory =
    brief.findings.length > 0 && brief.findings.every((finding) => finding.source === 'memory')
  const read = readStateOfBrief(brief)
  const {
    unread,
    pending,
    truncated,
    failed: failedReads,
    access: accessGaps,
    permissions: allPermissions,
  } = read
  const permissions = allPermissions.slice(0, 12)
  const openReads = read.open
  const gone = brief.coverage.flatMap((item) => item.gone)
  const scope = scopeText(brief, t, { findings: true, memory: true })
  const title = view.task.title
  const hasContent =
    Boolean(brief.verdict || brief.findings.length || brief.checks.length) || evidenceOnly
  const answered = brief.findings.length > 0 || brief.accepted.length > 0
  const dataExpanded = dataOpen ?? (!answered || brief.data?.view.kind === 'config')
  const ungrounded = new Set(brief.verdict?.ungrounded ?? [])
  const contradicted = new Set(brief.verdict?.contradicted ?? [])
  const shownIssues = brief.findings.length + brief.accepted.length
  const markdown = () =>
    [prefixMarkdown, briefMarkdown(title, brief, t, lang)].filter(Boolean).join('\n\n')
  const ruleTitle = (fix: BriefFix) =>
    [...brief.findings, ...brief.accepted, ...brief.resolved].find(
      (finding) => finding.bucket === fix.view.bucket && finding.code === fix.view.code,
    )?.title ?? fix.view.code.replace(/_/g, ' ')

  const reverify = async () => {
    setReverifying(true)
    setReverifyError(null)
    try {
      await onReverify()
    } catch (error) {
      setReverifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setReverifying(false)
    }
  }

  const exportEvidence = () => {
    const evidence = {
      generatedAt: new Date().toISOString(),
      task: { id: view.task.id, title },
      verdict: brief.verdict,
      findings: brief.findings.map((finding) => ({
        bucket: finding.bucket,
        code: finding.code,
        title: finding.title,
        severity: finding.severity,
        control: finding.control,
        detail: finding.detail,
        readAt: finding.readAt,
        source: finding.source,
        status: finding.status,
      })),
      accepted: brief.accepted.map((finding) => ({
        bucket: finding.bucket,
        code: finding.code,
        title: finding.title,
        acceptedAt: finding.readAt,
      })),
      checks: brief.checks.map((check) => ({
        id: check.id,
        tool: check.name,
        target: check.target,
        status: check.status,
        note: check.note,
        at: check.at,
        ms: check.ms,
        view: check.view,
      })),
      coverage: brief.coverage,
      blind: brief.blind,
      undecided: brief.undecided,
      changes: brief.changes,
      reverify: brief.reverify,
    }
    void window.agent.saveText({
      name: safeFileName(`${title}-evidence`, 'json'),
      content: JSON.stringify(evidence, null, 2),
      kind: 'json',
    })
  }

  const copy = async () => {
    if (await copyText(markdown())) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const saveBrief = () =>
    void window.agent.saveText({
      name: safeFileName(title, 'md'),
      content: markdown(),
      kind: 'markdown',
    })

  const savePdf = () => {
    // The print stylesheet cannot open React disclosures by itself. Expand the
    // evidence first, then hand the composited DOM to Chromium.
    setAllFindings(true)
    setOpenChecks(true)
    setDataOpen(true)
    window.setTimeout(() => void window.agent.exportPdf(), 80)
  }

  const accept = (finding: BriefFinding) =>
    finding.issueId
      ? () => void window.agent.acceptIssue(finding.issueId!, finding.status !== 'accepted')
      : undefined

  // j / k move between findings, Enter opens the evidence, a accepts or reopens.
  const navigate = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (!target.classList.contains('finding-main')) return
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('.finding-main') ?? [])]
    const index = rows.indexOf(target)
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      rows[Math.min(rows.length - 1, index + 1)]?.focus()
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      rows[Math.max(0, index - 1)]?.focus()
    } else if (event.key === 'a') {
      const key = target.closest<HTMLElement>('.finding-row')?.dataset.findingKey
      const finding = [...brief.findings, ...brief.accepted].find((item) => item.key === key)
      if (finding) accept(finding)?.()
    }
  }

  useEffect(() => {
    const prepare = () => {
      setAllFindings(true)
      setOpenChecks(true)
      setDataOpen(true)
    }
    window.addEventListener('sa:prepare-print', prepare)
    return () => window.removeEventListener('sa:prepare-print', prepare)
  }, [])

  const body = (
    <article
      className={evidenceOnly ? 'run-evidence' : 'brief'}
      ref={root}
      aria-busy={live}
      onKeyDown={navigate}
    >
      <h1 className="visually-hidden">{title}</h1>
      <div className={`brief-meta ${hasContent ? '' : 'silent'}`}>
        <span className={scope ? 'brief-scope' : undefined}>{scope}</span>
        {hasContent && (
          <span className="brief-actions">
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
                      saveBrief()
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
                    disabled={reverifying}
                    onClick={() => {
                      setMore(false)
                      void reverify()
                    }}
                  >
                    {reverifying ? t.reverifying : t.reverify}
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
        )}
      </div>

      {auditProgress && (
        <p className="audit-progress" role="status">
          {fill(auditProgress.phase === 'survey' ? t.auditSurvey : t.auditAccess, {
            account: auditProgress.account,
            done: auditProgress.done,
            total: auditProgress.total,
          })}
        </p>
      )}

      {!live && brief.questions.length > 0 && (
        <p className="brief-request" data-entry-id={brief.questions.at(-1)?.id ?? undefined}>
          {brief.questions.at(-1)?.text}
        </p>
      )}
      {live && brief.questions.length > 0 && (
        <p className="live-request">{brief.questions.at(-1)?.text}</p>
      )}

      <div aria-live="polite" aria-atomic="false">
        {!hideVerdict && brief.verdict && (
          <div
            className={`verdict prose ${brief.verdict.streaming ? 'streaming' : ''} ${
              brief.verdict.stale && live ? 'stale' : ''
            }`}
            data-verdict
            title={brief.verdict.stale && live ? t.staleVerdict : undefined}
          >
            <Suspense fallback={<p>{plainVerdict(brief.verdict.text)}</p>}>
              <Markdown
                text={brief.verdict.text}
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
                        title={missing ? t.ungroundedHint : wrong ? t.contradictedHint : undefined}
                      >
                        {children}
                      </code>
                    )
                  },
                }}
              />
            </Suspense>
          </div>
        )}
        {ungrounded.size > 0 && !brief.verdict?.streaming && (
          <p className="grounding">
            <TriangleAlert size={12} strokeWidth={1.7} aria-hidden="true" />
            {t.ungroundedNote}
          </p>
        )}
        {contradicted.size > 0 && !brief.verdict?.streaming && (
          <p className="grounding">
            <TriangleAlert size={12} strokeWidth={1.7} aria-hidden="true" />
            {t.contradictedNote}
          </p>
        )}

        {!hideNotices &&
          brief.notices.map((notice) => (
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

      {!live && !auditProgress && !brief.verdict && brief.checks.length === 0 && (
        <p className="brief-empty">{t.emptyStream}</p>
      )}

      {((!hideFindings && brief.findings.length > 0) ||
        brief.accepted.length > 0 ||
        brief.resolved.length > 0) && (
        <section className="brief-section" aria-label={t.findingsTitle}>
          {!hideFindings && brief.findings.length > 0 && <h2>{t.findingsTitle}</h2>}
          {!hideFindings && (
            <div className="findings-list">
              {findingGroups.map((group) => (
                <div className="finding-group" key={group.bucket || 'account'}>
                  {findingGroups.length > 1 && (
                    <p className="finding-group-title mono">{group.bucket || t.accountWide}</p>
                  )}
                  {group.items.map((finding) => (
                    <FindingRow
                      key={finding.key}
                      finding={finding}
                      t={t}
                      onOpen={() => revealCheck(finding.sourceId)}
                      onAccept={accept(finding)}
                      tagMemory={!allMemory}
                      showBucket={findingGroups.length === 1}
                      staleDays={staleDays}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
          {!hideFindings && brief.findings.length > FINDINGS_SHOWN && (
            <button
              className="more-toggle"
              type="button"
              aria-expanded={allFindings}
              onClick={() => setAllFindings((value) => !value)}
            >
              {allFindings
                ? t.less
                : fill(t.moreFindings, { n: brief.findings.length - FINDINGS_SHOWN })}
              <ChevronDown size={13} className={allFindings ? 'open' : undefined} />
            </button>
          )}
          {!hideFindings && brief.issueTotal !== null && brief.issueTotal > shownIssues && (
            <p className="quiet">
              {fill(t.issuesShown, { shown: shownIssues, total: brief.issueTotal })}
            </p>
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
                  staleDays={staleDays}
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

      {reverifyError && (
        <p className="brief-error">
          {t.reverifyFailed}: {reverifyError}
        </p>
      )}
      {!live && brief.reverify && (
        <section className="brief-section reverify-section" aria-label={t.reverifyTitle}>
          <h2>{t.reverifyTitle}</h2>
          <p className="quiet">
            {fill(brief.reverify.checked === 1 ? t.reverifyCheckedOne : t.reverifyChecked, {
              n: brief.reverify.checked,
              changed: brief.reverify.changes.length,
            })}{' '}
            · {new Date(brief.reverify.at).toLocaleString()}
          </p>
          {brief.reverify.skipped > 0 && (
            <p className="quiet">{fill(t.reverifySkipped, { n: brief.reverify.skipped })}</p>
          )}
          {brief.reverify.truncated && <p className="quiet">{t.reverifyTruncated}</p>}
          {brief.reverify.plan && (
            <div className="reverify-plan">
              <p className="quiet">
                {fill(t.planReverifySummary, {
                  confirmed: brief.reverify.plan.confirmed,
                  notApplied: brief.reverify.plan.notApplied,
                  unknown: brief.reverify.plan.unknown,
                })}
              </p>
              {brief.reverify.plan.steps.map((step) => (
                <p className="reverify-plan-row" key={`${step.bucket}:${step.code}`}>
                  <span className={`plan-status ${step.status}`}>
                    {step.status === 'confirmed'
                      ? t.planStatusConfirmed
                      : step.status === 'not_applied'
                        ? t.planStatusNotApplied
                        : t.planStatusUnknown}
                  </span>
                  <span className="mono">{step.bucket || t.accountWide}</span> · {step.title}
                </p>
              ))}
            </div>
          )}
          {brief.reverify.changes.length === 0 ? (
            brief.reverify.plan && brief.reverify.plan.notApplied > 0 ? (
              <p className="quiet">{t.reverifyPlanPending}</p>
            ) : (
              <p className="clean">{t.reverifyNoChange}</p>
            )
          ) : (
            <div className="change-list">
              {brief.reverify.changes.slice(0, 20).map((change) => (
                <div className="change-row" key={`${change.bucket}:${change.code}`}>
                  <span className="change-bucket mono">{change.bucket}</span>
                  <span className="change-field">{change.title}</span>
                  <span className="change-before">{stateLabel(change.before, t)}</span>
                  <span className="change-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="change-after">{stateLabel(change.after, t)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {!live && brief.changes.length > 0 && (
        <section className="brief-section changes-section" aria-label={t.changesTitle}>
          <h2>{t.changesTitle}</h2>
          <div className="change-list">
            {brief.changes.slice(0, 12).map((change, index) => (
              <div className="change-row" key={`${change.bucket}:${change.field}:${index}`}>
                <span className="change-bucket mono">{change.bucket}</span>
                <span className="change-field">{changeField(change.field, lang)}</span>
                <span className="change-before">{change.before}</span>
                <span className="change-arrow" aria-hidden="true">
                  →
                </span>
                <span className="change-after">{change.after}</span>
              </div>
            ))}
          </div>
          {brief.attribution && (
            <p className="quiet">
              {brief.attribution.events.length
                ? `${fill(t.attributionWindow, { days: brief.attribution.days ?? 90 })} · ${brief.attribution.events
                    .map(
                      (event) =>
                        `${event.event} · ${event.actor} · ${new Date(event.at).toLocaleString()}`,
                    )
                    .join('  ·  ')}`
                : brief.attribution.status === 'ok'
                  ? fill(t.attributionNone, { days: brief.attribution.days ?? 90 })
                  : `${t.attributionUnavailable} (${brief.attribution.status}, ${brief.attribution.days ?? 90}d).`}
              {brief.attribution.events.length && brief.attribution.status !== 'ok'
                ? ` · ${t.attributionUnavailable} (${brief.attribution.status})`
                : ''}
              {brief.attribution.truncated ? ` · ${t.attributionTruncated}` : ''}
            </p>
          )}
        </section>
      )}

      {(openReads > 0 || gone.length > 0) && !live && (
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
          {truncated > 0 && (
            <p className="blind">
              <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
              {fill(t.scopeTruncated, { n: truncated })}
            </p>
          )}
          {failedReads > 0 && (
            <p className="blind">
              <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
              {fill(t.failedReads, { n: failedReads })}
            </p>
          )}
          {accessGaps > 0 && (
            <p className="blind">
              <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
              {fill(t.accessOpen, { n: accessGaps })}
            </p>
          )}
          {brief.undecided.map((item) => (
            <p className="blind" key={item.code}>
              <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
              {fill(t.undecidedRule, {
                n: item.count,
                title: item.title,
                buckets: item.buckets.slice(0, 6).join(', '),
              })}
              {item.count > item.buckets.length && item.buckets.length === 20 ? ' …' : ''}
            </p>
          ))}
          {brief.blind.map((item) => (
            <p className="blind" key={item.key}>
              <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
              <span className="mono">{item.bucket}</span> · {item.title}
            </p>
          ))}
          {permissions.map((gap) => (
            <p className="blind permission-gap" key={`${gap.bucket}:${gap.action}`}>
              <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
              <span className="mono">{gap.bucket}</span> · {gap.item} · <code>{gap.action}</code>
            </p>
          ))}
          {gone.length > 0 && (
            <p className="quiet">{fill(t.goneBuckets, { names: gone.join(', ') })}</p>
          )}
        </section>
      )}

      {!answered && read.complete && !live && (
        <section className="brief-section">
          <p className="clean">{t.noFindingsClean}</p>
        </section>
      )}

      {!hideFix && <FixSection fixes={brief.fixes} titleOf={ruleTitle} t={t} />}

      {!hideData && brief.data && (
        <section className="brief-section data-section">
          <button
            className="section-head"
            type="button"
            aria-expanded={dataExpanded}
            onClick={() => setDataOpen(!dataExpanded)}
          >
            <span className="section-title">
              {brief.data.view.kind === 'config' ? t.accessTitle : t.dataTitle}
            </span>
            <span className="section-target data-count">{dataSummary(brief.data, t)}</span>
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
    </article>
  )
  return evidenceOnly ? body : <div className="scroll">{body}</div>
}
