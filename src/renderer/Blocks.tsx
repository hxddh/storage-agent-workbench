import type { ChartSpec, Table, TreeNode, ViewBlock, ViewDoc, ViewTone } from '@shared/contract'
import type { Dict } from './i18n'
import Markdown from './Markdown'
import { TableView } from './Views'

function toneClass(tone: ViewTone | undefined): string {
  return tone ?? 'info'
}

function tableOf(block: Extract<ViewBlock, { type: 'table' }>): Table {
  return {
    columns: block.columns.map((column) => column.label ?? column.key),
    rows: block.rows.map((row) =>
      block.columns.map((column) => {
        const value = row[column.key]
        if (typeof value === 'boolean') return value ? 'true' : 'false'
        return value ?? null
      }),
    ),
  }
}

function ChartBlock({ spec, t }: { spec: ChartSpec; t: Dict }) {
  const values = spec.data
    .map((row) => Number(row[spec.y]))
    .filter((value) => Number.isFinite(value))
  if (values.length < 2) return <p className="quiet">{t.noRows}</p>
  const width = 720
  const height = 220
  const pad = 24
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 1)
  const span = max - min || 1
  const x = (index: number) => pad + (index * (width - pad * 2)) / Math.max(1, values.length - 1)
  const y = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2)
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(' ')
  const area = `${pad},${height - pad} ${points} ${width - pad},${height - pad}`
  const labels = spec.data.map((row) => String(row[spec.x] ?? ''))
  return (
    <figure className="view-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${spec.y} by ${spec.x}`}
        preserveAspectRatio="none"
      >
        {[0, 0.5, 1].map((part) => (
          <line
            key={part}
            x1={pad}
            x2={width - pad}
            y1={pad + part * (height - pad * 2)}
            y2={pad + part * (height - pad * 2)}
            className="chart-grid"
          />
        ))}
        {spec.mark === 'bar' ? (
          values.map((value, index) => {
            const bar = (width - pad * 2) / values.length
            return (
              <rect
                key={index}
                x={x(index) - bar * 0.35}
                y={y(value)}
                width={bar * 0.7}
                height={height - pad - y(value)}
                className="chart-bar"
              />
            )
          })
        ) : (
          <>
            {spec.mark === 'area' && <polygon points={area} className="chart-area" />}
            <polyline points={points} className="chart-line" />
            {spec.mark === 'point' &&
              values.map((value, index) => (
                <circle key={index} cx={x(index)} cy={y(value)} r={3} className="chart-point" />
              ))}
          </>
        )}
      </svg>
      <figcaption>
        <span>{spec.xLabel ?? spec.x}</span>
        <span>{spec.yLabel ?? spec.y}</span>
      </figcaption>
      <div className="chart-labels">
        {labels.map((label, index) => (
          <span key={index}>{label}</span>
        ))}
      </div>
    </figure>
  )
}

function Tree({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul className="view-tree">
      {nodes.map((node, index) => (
        <li key={`${node.label}:${index}`}>
          <span className="view-tree-label">{node.label}</span>
          {node.detail && <span className="view-tree-detail">{node.detail}</span>}
          {node.children?.length ? <Tree nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
  )
}

function Block({ block, t }: { block: ViewBlock; t: Dict }) {
  switch (block.type) {
    case 'markdown':
      return (
        <div className="prose view-markdown">
          <Markdown text={block.text} components={{}} />
        </div>
      )
    case 'section':
      return (
        <section className="view-section">
          {block.title && <h3>{block.title}</h3>}
          <div className="view-stack">
            {block.blocks.map((item, index) => (
              <Block block={item} t={t} key={index} />
            ))}
          </div>
        </section>
      )
    case 'stack':
      return (
        <div className={`view-stack gap-${block.gap ?? 'm'}`}>
          {block.blocks.map((item, index) => (
            <Block block={item} t={t} key={index} />
          ))}
        </div>
      )
    case 'row':
      return (
        <div className="view-row">
          {block.blocks.map((item, index) => (
            <Block block={item} t={t} key={index} />
          ))}
        </div>
      )
    case 'table':
      return (
        <div className="view-table">
          {block.caption && <p className="view-caption">{block.caption}</p>}
          <TableView table={tableOf(block)} name={block.caption ?? 'view'} empty={t.noRows} t={t} />
        </div>
      )
    case 'chart':
      return (
        <div className="view-table">
          {block.caption && <p className="view-caption">{block.caption}</p>}
          <ChartBlock spec={block.spec} t={t} />
        </div>
      )
    case 'code':
      return (
        <figure className="view-code">
          {block.caption && <figcaption>{block.caption}</figcaption>}
          <pre className="code">{block.text}</pre>
        </figure>
      )
    case 'callout':
      return (
        <aside className={`view-callout ${toneClass(block.tone)}`}>
          {block.title && <strong>{block.title}</strong>}
          <p>{block.text}</p>
        </aside>
      )
    case 'kv':
      return (
        <dl className="view-kv">
          {block.rows.map((row, index) => (
            <div key={`${row.label}:${index}`}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )
    case 'tree':
      return <Tree nodes={block.nodes} />
    case 'diff':
      return (
        <div className="view-diff">
          <pre className="code diff-before">{block.before}</pre>
          <pre className="code diff-after">{block.after}</pre>
        </div>
      )
    case 'timeline':
      return (
        <ol className="view-timeline">
          {block.events.map((event, index) => (
            <li key={`${event.at}:${index}`} className={toneClass(event.tone)}>
              <span className="view-time">{event.at}</span>
              <span>
                <strong>{event.title}</strong>
                {event.detail && <span className="view-detail">{event.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )
    case 'link':
      return (
        <a className="view-link" href={block.href} target="_blank" rel="noreferrer">
          {block.text}
        </a>
      )
  }
}

/** A view the agent composed; the window owns layout, accessibility and export. */
export function Blocks({ doc, t }: { doc: ViewDoc; t: Dict }) {
  return (
    <div className="view-doc">
      {doc.blocks.map((block, index) => (
        <Block block={block} t={t} key={index} />
      ))}
    </div>
  )
}
