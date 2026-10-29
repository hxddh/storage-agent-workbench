import type { Chart, Table, ToolView } from '@shared/contract'
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

/** A read's sections ({ status, value | error }) or one document, as JSON. */
function RawView({ value }: { value: unknown }) {
  const entries =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>)
      : []
  const sectioned =
    entries.length > 0 &&
    entries.every(
      ([key, item]) =>
        key === 'region' ||
        (item !== null && typeof item === 'object' && 'status' in (item as object)),
    )
  if (!sectioned) return <pre className="code">{JSON.stringify(value, null, 2)}</pre>
  return (
    <div className="raw-sections">
      {entries.map(([key, item]) => {
        if (key === 'region')
          return (
            <div className="raw-section" key={key}>
              <span className="raw-name mono">region</span>
              <span className="raw-status">{String(item ?? '—')}</span>
            </div>
          )
        const read = item as { status: string; value?: unknown; error?: string }
        return (
          <div className="raw-section" key={key}>
            <span className="raw-name mono">{key}</span>
            <span className={`raw-status ${read.status}`}>{read.status.replace(/_/g, ' ')}</span>
            {read.value !== undefined && (
              <pre className="code">{JSON.stringify(read.value, null, 2)}</pre>
            )}
            {read.error && <p className="raw-error">{read.error}</p>}
          </div>
        )
      })}
    </div>
  )
}

export function ToolViewBody({
  view,
  t,
  taskTitle,
  limit,
}: {
  view: ToolView
  t: Dict
  taskTitle: string
  limit?: number
}) {
  if (view.kind === 'buckets' || view.kind === 'objects') {
    return (
      <TableView
        table={view.rows}
        name={taskTitle || view.kind}
        empty={view.kind === 'buckets' ? t.noBuckets : t.noObjects}
        t={t}
        limit={limit}
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
  if (view.kind === 'raw') return <RawView value={view.value} />
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
  if (view.kind === 'note') return <p className="quiet">{view.text}</p>
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

  return null
}
