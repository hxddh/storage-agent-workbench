import type {
  Chart,
  ConfigFinding,
  FixFormat,
  Impact,
  IssueRow,
  NoteRow,
  Table,
  ToolView,
} from '@shared/contract'
import { Check, Copy, Download, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { type Dict, fill } from './i18n'
import { copyText, safeFileName, toCsv } from './lib/export'

/** Bytes as people read them; a CSV keeps the raw number. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const BYTE_COLUMN = /^(bytes|size|size_bytes|total_bytes|sizebytes)$/i

function display(column: string, cell: string | number | null): string {
  if (cell === null || cell === '') return '—'
  if (typeof cell === 'number' && BYTE_COLUMN.test(column)) return humanBytes(cell)
  return String(cell)
}

export function TableView({
  table,
  name,
  empty,
  t,
  limit,
  tools = true,
}: {
  table: Table
  name: string
  empty: string
  t: Dict
  limit?: number
  tools?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const shown = limit && !expanded ? table.rows.slice(0, limit) : table.rows
  if (table.rows.length === 0) return <p className="view-empty">{empty}</p>
  return (
    <div className="table-block">
      {tools && (
        <div className="table-tools">
          <button
            className="text-action"
            type="button"
            onClick={async () => {
              if (await copyText(toCsv(table))) {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }
            }}
          >
            <Copy size={12} />
            {copied ? t.copied : t.copyCsv}
          </button>
          <button
            className="text-action"
            type="button"
            onClick={() =>
              void window.agent.saveText({
                name: safeFileName(name, 'csv'),
                content: toCsv(table),
                kind: 'csv',
              })
            }
          >
            <Download size={12} />
            {t.saveAs}
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{display(table.columns[cellIndex] ?? '', cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {limit && table.rows.length > limit && (
        <button
          className="text-action table-more"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t.less : fill(t.moreRows, { n: table.rows.length - limit })}
        </button>
      )}
    </div>
  )
}

function Issues({ issues, t }: { issues: IssueRow[]; t: Dict }) {
  if (issues.length === 0) return <p className="view-sub">{t.noIssues}</p>
  return (
    <div className="issue-list">
      {issues.slice(0, 12).map((issue) => (
        <div className="issue" key={issue.id}>
          <span className={`sev ${issue.severity}`} />
          <span className="bucket">{issue.bucket}</span>
          <span>{issue.title}</span>
          {issue.status === 'accepted' && <span className="code">{t.accepted}</span>}
          {issue.recurred > 0 && <span className="code">×{issue.recurred + 1}</span>}
        </div>
      ))}
    </div>
  )
}

export function ChartView({ chart }: { chart: Chart }) {
  const max = Math.max(...chart.values, 1)
  return (
    <div>
      <div className="chart">
        {chart.values.map((value, index) => (
          <div
            className="bar"
            key={index}
            style={{ height: `${Math.max(3, (value / max) * 100)}%` }}
            title={`${chart.labels[index]}: ${value}`}
          >
            <span>{value}</span>
          </div>
        ))}
      </div>
      <div className="chart-labels">
        {chart.labels.map((label, index) => (
          <span key={index}>{label}</span>
        ))}
      </div>
    </div>
  )
}

export function FixView({ formats, impact, t }: { formats: FixFormat[]; impact: Impact; t: Dict }) {
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const format = formats[active]
  const label =
    impact.verdict === 'low'
      ? t.impactLow
      : impact.verdict === 'caution'
        ? t.impactCaution
        : t.impactUnknown
  return (
    <div>
      <div className="tabs">
        {formats.map((item, index) => (
          <button
            key={item.label}
            type="button"
            className={`tab ${index === active ? 'active' : ''}`}
            onClick={() => setActive(index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {format && <pre className="code">{format.text}</pre>}
      <div className="table-tools">
        <button
          className="text-action"
          type="button"
          onClick={async () => {
            if (!format) return
            if (await copyText(format.text)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t.copied : t.copy}
        </button>
      </div>
      <div className="impact-block">
        <span className={`impact ${impact.verdict}`}>
          <span className="dot" />
          {label}
        </span>
        {impact.reasons.map((reason, index) => (
          <p className="impact-note" key={index}>
            {reason}
          </p>
        ))}
        {impact.gap && <p className="impact-note">— {impact.gap}</p>}
      </div>
      <p className="view-sub">{t.copyHint}</p>
    </div>
  )
}

export function ToolViewBody({
  view,
  t,
  taskTitle,
}: {
  view: ToolView
  t: Dict
  taskTitle: string
}) {
  if (view.kind === 'survey') {
    return (
      <div>
        <div className="view-head">
          <span className="view-title">{view.provider}</span>
          <span className="view-sub">
            {view.coverage.visible} {t.visible} · {view.coverage.processed} {t.processed}
            {view.coverage.denied.length ? ` · ${view.coverage.denied.length} ${t.denied}` : ''}
            {view.coverage.unknown.length
              ? ` · ${view.coverage.unknown.length} ${t.unknownExposure}`
              : ''}
            {view.coverage.truncated ? ` · ${t.truncated}` : ''}
            {view.coverage.pending
              ? ` · ${fill(t.pendingBuckets, { n: view.coverage.pending })}`
              : ''}
          </span>
        </div>
        <TableView
          table={view.buckets}
          name={`${view.provider}-buckets`}
          empty={t.noBuckets}
          t={t}
        />
        <Issues issues={view.issues} t={t} />
      </div>
    )
  }
  if (view.kind === 'buckets' || view.kind === 'objects') {
    return (
      <TableView
        table={view.rows}
        name={taskTitle || view.kind}
        empty={view.kind === 'buckets' ? t.noBuckets : t.noObjects}
        t={t}
      />
    )
  }
  if (view.kind === 'object') {
    if (view.facts.length === 0) return <p className="view-empty">{t.noRows}</p>
    return (
      <div>
        <dl className="facts">
          {view.facts.map(([key, value]) => (
            <div key={key} className="fact-row">
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {view.preview && <pre className="code">{view.preview.text}</pre>}
      </div>
    )
  }
  if (view.kind === 'config') {
    if (view.findings.length === 0) return <p className="view-empty">{t.noFindings}</p>
    return (
      <div className="findings">
        {view.findings.map((finding: ConfigFinding, index) => (
          <div className="finding" key={index}>
            <span className={`sev ${finding.severity}`} />
            <div className="body">
              <div className="t">{finding.title}</div>
              <div className="d">{finding.detail}</div>
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (view.kind === 'probe') {
    return (
      <div className="checks">
        {view.checks.map((check) => (
          <div className="check" key={check.name}>
            {check.ok ? (
              <Check size={13} className="ok" />
            ) : (
              <TriangleAlert size={13} className="bad" />
            )}
            <span>{check.name}</span>
            <span className="detail">{check.detail}</span>
            <span className="ms">{check.ms} ms</span>
          </div>
        ))}
      </div>
    )
  }
  if (view.kind === 'estate') {
    if (!view.buckets && view.issues.length === 0 && view.notes.length === 0) {
      return <p className="view-empty">{t.emptyEstate}</p>
    }
    return (
      <div>
        {view.buckets && (
          <TableView
            table={view.buckets}
            name={`${taskTitle || 'estate'}-buckets`}
            empty={t.emptyEstate}
            t={t}
          />
        )}
        {view.issues.length > 0 && <Issues issues={view.issues} t={t} />}
        {view.notes.length > 0 && (
          <div className="notes">
            <div className="view-sub">{t.notes}</div>
            {view.notes.map((note: NoteRow) => (
              <p key={note.id} className="impact-note">
                {note.text}
              </p>
            ))}
          </div>
        )}
      </div>
    )
  }
  if (view.kind === 'fix') {
    return <FixView formats={view.formats} impact={view.impact} t={t} />
  }
  if (view.kind === 'analyze') {
    return (
      <div>
        <div className="view-head">
          <span className="view-title">{view.dataset}</span>
          {view.note && <span className="view-sub">{view.note}</span>}
        </div>
        {view.chart && <ChartView chart={view.chart} />}
        <TableView
          table={view.rows}
          name={`${view.dataset.split('.')[0] ?? 'analysis'}-${view.dataset.split('.').pop() ?? 'csv'}`}
          empty={t.noRows}
          t={t}
        />
      </div>
    )
  }
  if (view.kind === 'query') {
    return (
      <div>
        <div className="view-sub">{t.queryCode}</div>
        <pre className="code">{view.code}</pre>
        {view.output && (
          <>
            <div className="view-sub">{t.queryOutput}</div>
            <pre className="code">{view.output}</pre>
          </>
        )}
      </div>
    )
  }
  return <p className="impact-note">{view.text}</p>
}
