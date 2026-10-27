import type { Lang, Table, TaskView, ToolName, ToolView, Usage } from '@shared/contract'
import type {
  CallFact,
  ChangePlanFact,
  DataFact,
  RunFacts as FactsModel,
  NoticeFact,
  RiskFact,
} from '@shared/facts'
import { deriveFacts, readState } from '@shared/facts'
import {
  Activity,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  FileText,
  List,
  ListChecks,
  Radar,
  Shield,
  StickyNote,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Dict, dict, fill, toolLabel } from './i18n'
import { ago, duration } from './time'
import {
  AccessChain,
  ChangePlanView,
  ChangeTextView,
  ChartView,
  humanBytes,
  planSummary,
  TableView,
  ToolViewBody,
} from './Views'

const ICONS: Record<ToolName, typeof Radar> = {
  survey: Radar,
  buckets: Database,
  objects: List,
  object: FileText,
  config: Shield,
  probe: Activity,
  estate: StickyNote,
  change_plan: Wrench,
  note: StickyNote,
  query: Code2,
  skill: BookOpen,
  plan: ListChecks,
}

const FINDINGS_SHOWN = 5

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

function severityLabel(finding: RiskFact, t: Dict): string {
  return finding.severity === 'high'
    ? t.severityHigh
    : finding.severity === 'medium'
      ? t.severityMedium
      : t.severityLow
}

export function noticeText(notice: NoticeFact, t: Dict): string {
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

export function factsMarkdown(title: string, brief: FactsModel, t: Dict, lang: Lang): string {
  const parts: string[] = [`# ${title}`]
  if (brief.answer?.text) parts.push(brief.answer.text)
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
  const plan = brief.changePlans.find((plan) => plan.view.plan)?.view.plan
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
    for (const plan of brief.changePlans) {
      const view = plan.view
      parts.push(`## ${t.changePlanTitle} ${view.bucket}`)
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
  if (brief.methods.length) {
    parts.push(
      `## ${t.runMethods}`,
      brief.methods.map((method) => `- **${method.title}** — ${method.description}`).join('\n'),
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
  finding: RiskFact
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

function DataSection({ data, t }: { data: DataFact; t: Dict }) {
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

function dataSummary(data: DataFact, t: Dict): string {
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
  check: CallFact
  open: boolean
  onToggle: () => void
  lang: Lang
  t: Dict
  taskTitle: string
}) {
  const Icon = ICONS[check.name] ?? Activity
  // The call row is the audit surface; every settled view can open here, even
  // when the same result is the primary proof above.
  const expandable = Boolean(check.view) && check.status !== 'running'
  const shown = duration(check.ms)
  const status =
    check.status === 'failed'
      ? t.runWorkFailed
      : check.status === 'stopped'
        ? t.runWorkStopped
        : check.status === 'timeout'
          ? t.runWorkTimeout
          : check.status === 'refused'
            ? t.runWorkRefused
            : null
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
        {status && <span className={`check-status ${check.status}`}>{status}</span>}
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

function ChangeSection({
  changePlans,
  titleOf,
  t,
}: {
  changePlans: ChangePlanFact[]
  titleOf: (plan: ChangePlanFact) => string
  t: Dict
}) {
  const plan = changePlans.find((plan) => plan.view.plan)?.view.plan
  if (plan) {
    return (
      <section className="brief-section" aria-label={t.planTitle}>
        <h2>{t.planTitle}</h2>
        <ChangePlanView plan={plan} t={t} />
      </section>
    )
  }
  const [first, ...rest] = changePlans
  if (!first) return null
  return (
    <section className="brief-section" aria-label={t.changePlanTitle}>
      <h2>
        {t.changePlanTitle} <span className="section-target mono">{first.view.bucket}</span>
        <span className="section-sub">{titleOf(first)}</span>
      </h2>
      <ChangeTextView formats={first.view.formats} impact={first.view.impact} t={t} />
      {rest.length > 0 && (
        <Fold label={fill(t.moreChangeSteps, { n: rest.length })}>
          {rest.map((plan) => (
            <div className="change-more" key={plan.key}>
              <h3>
                <span className="mono">{plan.view.bucket}</span> · {titleOf(plan)}
              </h3>
              <ChangeTextView formats={plan.view.formats} impact={plan.view.impact} t={t} />
            </div>
          ))}
        </Fold>
      )}
    </section>
  )
}

function receipt(brief: FactsModel, usage: Usage | null, t: Dict): string {
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

type SourceSection =
  | 'risks'
  | 'data'
  | 'change'
  | 'checks'
  | 'notChecked'
  | 'reverify'
  | 'changes'
  | 'methods'

function SourceRow({
  section,
  label,
  detail,
  open,
  onToggle,
}: {
  section: SourceSection
  label: string
  detail?: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      className={`source-row ${open ? 'open' : ''}`}
      type="button"
      data-source={section}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="source-label">{label}</span>
      {detail ? <span className="source-detail">{detail}</span> : null}
      <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} aria-hidden="true" />
    </button>
  )
}

export function Sources({
  view,
  lang,
  focusId,
  staleDays = 7,
  hideData = false,
  hideChange = false,
}: {
  view: TaskView
  lang: Lang
  focusId: string | null
  staleDays?: number
  hideData?: boolean
  hideChange?: boolean
}) {
  const t = dict(lang)
  const brief = useMemo(
    () => deriveFacts(view.entries, view.live, view.issueStatus),
    [view.entries, view.live, view.issueStatus],
  )
  const [open, setOpen] = useState<SourceSection | null>(null)
  const [openCheck, setOpenCheck] = useState<string | null>(null)
  const [allFindings, setAllFindings] = useState(false)
  const [printing, setPrinting] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const focused = useRef<string | null>(null)
  const read = readState(brief)
  const gone = brief.coverage.flatMap((item) => item.gone)
  const visibleFindings = allFindings ? brief.findings : brief.findings.slice(0, FINDINGS_SHOWN)
  const findingGroups = [
    ...new Map(
      visibleFindings.map((finding) => [
        finding.bucket || '',
        { bucket: finding.bucket, items: [] as RiskFact[] },
      ]),
    ).values(),
  ]
  for (const finding of visibleFindings) {
    const group = findingGroups.find((item) => item.bucket === finding.bucket)
    group?.items.push(finding)
  }
  const allMemory =
    brief.findings.length > 0 && brief.findings.every((finding) => finding.source === 'memory')
  const shownRisks = brief.findings.length + brief.accepted.length
  const ruleTitle = (plan: ChangePlanFact) =>
    [...brief.findings, ...brief.accepted, ...brief.resolved].find(
      (finding) => finding.bucket === plan.view.bucket && finding.code === plan.view.code,
    )?.title ?? plan.view.code.replace(/_/g, ' ')
  const accept = (finding: RiskFact) =>
    finding.issueId
      ? () => void window.agent.acceptIssue(finding.issueId!, finding.status !== 'accepted')
      : undefined
  const show = (section: SourceSection) => printing || open === section

  const revealCheck = useCallback((id: string) => {
    setOpen('checks')
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
    if (focusId === 'reverify') {
      setOpen('reverify')
      return
    }
    if (focusId.startsWith('f:')) {
      setOpen('risks')
      const rest = focusId.slice(2)
      const key = rest.slice(rest.indexOf(':') + 1)
      if (brief.findings.findIndex((finding) => finding.key === key) >= FINDINGS_SHOWN)
        setAllFindings(true)
      setTimeout(() => {
        const element = root.current?.querySelector<HTMLElement>(
          `[data-finding-key="${CSS.escape(key)}"]`,
        )
        if (!element) return
        element.scrollIntoView({ block: 'center' })
        element.classList.add('flash')
        setTimeout(() => element.classList.remove('flash'), 1600)
      }, 40)
      return
    }
    if (brief.data?.sourceId === focusId) {
      setOpen('data')
      return
    }
    if (brief.checks.some((check) => check.id === focusId)) revealCheck(focusId)
  }, [focusId, brief, revealCheck])

  useEffect(() => {
    const prepare = () => setPrinting(true)
    window.addEventListener('sa:prepare-print', prepare)
    return () => window.removeEventListener('sa:prepare-print', prepare)
  }, [])

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

  const rows = (
    <div className="source-index">
      {shownRisks > 0 && (
        <SourceRow
          section="risks"
          label={t.findingsTitle}
          detail={`${brief.findings.length} ${t.homeOpen}${
            brief.accepted.length ? ` · ${fill(t.acceptedCount, { n: brief.accepted.length })}` : ''
          }`}
          open={show('risks')}
          onToggle={() => setOpen(open === 'risks' ? null : 'risks')}
        />
      )}
      {!hideData && brief.data && (
        <SourceRow
          section="data"
          label={brief.data.view.kind === 'config' ? t.accessTitle : t.dataTitle}
          detail={dataSummary(brief.data, t)}
          open={show('data')}
          onToggle={() => setOpen(open === 'data' ? null : 'data')}
        />
      )}
      {!hideChange && brief.changePlans.length > 0 && (
        <SourceRow
          section="change"
          label={t.planTitle}
          detail=""
          open={show('change')}
          onToggle={() => setOpen(open === 'change' ? null : 'change')}
        />
      )}
      {brief.checks.length > 0 && (
        <SourceRow
          section="checks"
          label={t.checksTitle}
          detail=""
          open={show('checks')}
          onToggle={() => setOpen(open === 'checks' ? null : 'checks')}
        />
      )}
      {(read.open > 0 || gone.length > 0) && (
        <SourceRow
          section="notChecked"
          label={t.openQuestions}
          detail={String(read.open + gone.length)}
          open={show('notChecked')}
          onToggle={() => setOpen(open === 'notChecked' ? null : 'notChecked')}
        />
      )}
      {brief.reverify && (
        <SourceRow
          section="reverify"
          label={t.reverifyTitle}
          detail=""
          open={show('reverify')}
          onToggle={() => setOpen(open === 'reverify' ? null : 'reverify')}
        />
      )}
      {brief.changes.length > 0 && (
        <SourceRow
          section="changes"
          label={t.changesTitle}
          detail={String(brief.changes.length)}
          open={show('changes')}
          onToggle={() => setOpen(open === 'changes' ? null : 'changes')}
        />
      )}
      {brief.methods.length > 0 && (
        <SourceRow
          section="methods"
          label={t.runMethods}
          detail={String(brief.methods.length)}
          open={show('methods')}
          onToggle={() => setOpen(open === 'methods' ? null : 'methods')}
        />
      )}
    </div>
  )

  const risks = (
    <section className="source-section" aria-label={t.findingsTitle}>
      {brief.findings.length > 0 ? (
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
      ) : (
        <p className="quiet">{t.noIssues}</p>
      )}
      {brief.findings.length > FINDINGS_SHOWN && (
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
      {brief.issueTotal !== null && brief.issueTotal > shownRisks && (
        <p className="quiet">
          {fill(t.issuesShown, { shown: shownRisks, total: brief.issueTotal })}
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
  )

  const notChecked = (
    <section className="source-section blind-section" aria-label={t.openQuestions}>
      {read.unread > 0 && (
        <p className="blind">
          <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.blind, { n: read.unread })}
        </p>
      )}
      {read.pending > 0 && (
        <p className="blind">
          <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.pendingBuckets, { n: read.pending })}
        </p>
      )}
      {read.truncated > 0 && (
        <p className="blind">
          <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.scopeTruncated, { n: read.truncated })}
        </p>
      )}
      {read.failed > 0 && (
        <p className="blind">
          <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.failedReads, { n: read.failed })}
        </p>
      )}
      {read.access > 0 && (
        <p className="blind">
          <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
          {fill(t.accessOpen, { n: read.access })}
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
      {read.permissions.slice(0, 12).map((gap) => (
        <p className="blind permission-gap" key={`${gap.bucket}:${gap.action}`}>
          <TriangleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
          <span className="mono">{gap.bucket}</span> · {gap.item} · <code>{gap.action}</code>
        </p>
      ))}
      {gone.length > 0 && (
        <p className="quiet">{fill(t.goneBuckets, { names: gone.join(', ') })}</p>
      )}
    </section>
  )

  const reverify = brief.reverify && (
    <section className="source-section reverify-section" aria-label={t.reverifyTitle}>
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
  )

  const changes = brief.changes.length > 0 && (
    <section className="source-section changes-section" aria-label={t.changesTitle}>
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
  )

  const methods = brief.methods.length > 0 && (
    <section className="source-section" aria-label={t.runMethods}>
      {brief.methods.map((method) => (
        <div className="method-row" key={method.id}>
          <span className="method-title">{method.title}</span>
          <span className="method-desc">{method.description}</span>
        </div>
      ))}
    </section>
  )

  const checks = brief.checks.length > 0 && (
    <section className="source-section checks-section">
      <p className="quiet source-receipt" role="status">
        {receipt(brief, view.usage, t)}
      </p>
      <div className="checks-list">
        {brief.checks.map((check) => (
          <CheckRow
            key={check.id}
            check={check}
            open={openCheck === check.id}
            onToggle={() => setOpenCheck((id) => (id === check.id ? null : check.id))}
            lang={lang}
            t={t}
            taskTitle={view.task.title}
          />
        ))}
      </div>
    </section>
  )

  const hasRows =
    shownRisks > 0 ||
    (!hideData && brief.data) ||
    (!hideChange && brief.changePlans.length > 0) ||
    brief.checks.length > 0 ||
    read.open > 0 ||
    gone.length > 0 ||
    Boolean(brief.reverify) ||
    brief.changes.length > 0 ||
    brief.methods.length > 0

  if (!hasRows) return <p className="source-empty">{t.emptyStream}</p>

  return (
    <article className="run-sources" ref={root} aria-busy={Boolean(view.live)} onKeyDown={navigate}>
      {rows}
      {show('risks') && risks}
      {show('data') && brief.data && <DataSection data={brief.data} t={t} />}
      {show('change') && !hideChange && (
        <ChangeSection changePlans={brief.changePlans} titleOf={ruleTitle} t={t} />
      )}
      {show('checks') && checks}
      {show('notChecked') && notChecked}
      {show('reverify') && reverify}
      {show('changes') && changes}
      {show('methods') && methods}
    </article>
  )
}
