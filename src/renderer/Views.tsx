import type { Chart, FixFormat, IssueRow, NoteRow, Table, ToolView } from '@shared/contract'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import type { Dict } from './i18n'

function DataTable({ table }: { table: Table }) {
  return (
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
          {table.rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell === null || cell === '' ? '—' : String(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
          {issue.recurred > 0 && <span className="code">×{issue.recurred + 1}</span>}
        </div>
      ))}
    </div>
  )
}

function ChartView({ chart }: { chart: Chart }) {
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

function FixView({
  formats,
  impact,
  t,
}: {
  formats: FixFormat[]
  impact: ToolView extends never ? never : any
  t: Dict
}) {
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
      <div className="copy-row">
        <button
          className="btn ghost"
          type="button"
          onClick={async () => {
            if (!format) return
            await navigator.clipboard.writeText(format.text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t.copied : t.copy}
        </button>
      </div>
      <div style={{ marginTop: 10 }}>
        <span className={`impact ${impact.verdict}`}>
          <span className="dot" />
          {label}
        </span>
        {impact.reasons.map((reason: string, index: number) => (
          <p className="impact-note" key={index}>
            {reason}
          </p>
        ))}
        {impact.gap && <p className="impact-note">— {impact.gap}</p>}
      </div>
      <p className="view-sub" style={{ marginTop: 8 }}>
        {t.copyHint}
      </p>
    </div>
  )
}

export function ToolViewBody({ view, t }: { view: ToolView; t: Dict }) {
  if (view.kind === 'survey') {
    return (
      <div>
        <div className="view-head">
          <span className="view-title">
            {view.provider} · {view.coverage.processed} {t.bucketsShort}
          </span>
          <span className="view-sub">
            {view.changed.opened} {t.opened} · {view.changed.resolved} {t.resolved}
            {view.changed.recurred ? ` · ${view.changed.recurred} ${t.recurred}` : ''}
          </span>
        </div>
        <DataTable table={view.buckets} />
        <div className="view-sub" style={{ marginTop: 8 }}>
          {view.coverage.visible} {t.visible} · {view.coverage.processed} {t.processed}
          {view.coverage.denied.length ? ` · ${view.coverage.denied.length} ${t.denied}` : ''}
          {view.coverage.unknown.length
            ? ` · ${view.coverage.unknown.length} ${t.unknownExposure}`
            : ''}
          {view.coverage.truncated ? ` · ${t.truncated}` : ''}
        </div>
        <Issues issues={view.issues} t={t} />
      </div>
    )
  }
  if (view.kind === 'buckets' || view.kind === 'objects') {
    return <DataTable table={view.rows} />
  }
  if (view.kind === 'object') {
    return (
      <div>
        <dl className="facts">
          {view.facts.map(([key, value]) => (
            <div key={key} style={{ display: 'contents' }}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {view.preview && (
          <pre className="code" style={{ marginTop: 12 }}>
            {view.preview.text}
          </pre>
        )}
      </div>
    )
  }
  if (view.kind === 'config') {
    if (view.findings.length === 0) return <p className="view-sub">No problems found.</p>
    return (
      <div className="findings">
        {view.findings.map((finding, index) => (
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
    return (
      <div>
        {view.buckets && <DataTable table={view.buckets} />}
        <Issues issues={view.issues} t={t} />
        {view.notes.length > 0 && (
          <div style={{ marginTop: 12 }}>
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
        <DataTable table={view.rows} />
      </div>
    )
  }
  return <p className="impact-note">{view.text}</p>
}
