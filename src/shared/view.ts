/**
 * The view an agent composes with `render`.
 *
 * This is data, never HTML or code. The window owns the renderer and the
 * accessibility of each block; the agent owns what is shown and in what order.
 * A block may be nested arbitrarily; there is no fixed report shape.
 */

export type ViewTone = 'info' | 'warn' | 'danger' | 'ok'

export interface ViewColumn {
  key: string
  label?: string
  /** How a value reads; the CSV keeps the raw value. */
  format?: 'text' | 'number' | 'bytes' | 'percent' | 'date'
}

export type ViewCell = string | number | boolean | null

export interface ChartSpec {
  mark: 'bar' | 'line' | 'area' | 'point'
  x: string
  y: string
  /** A column whose values split the series. */
  series?: string
  data: Record<string, ViewCell>[]
  xLabel?: string
  yLabel?: string
}

export interface TreeNode {
  label: string
  detail?: string
  children?: TreeNode[]
}

export interface TimelineEvent {
  at: string
  title: string
  detail?: string
  tone?: ViewTone
}

export type ViewBlock =
  | { type: 'markdown'; text: string }
  | { type: 'section'; title?: string; blocks: ViewBlock[] }
  | { type: 'stack'; gap?: 's' | 'm' | 'l'; blocks: ViewBlock[] }
  | { type: 'row'; blocks: ViewBlock[] }
  | {
      type: 'table'
      columns: ViewColumn[]
      rows: Record<string, ViewCell>[]
      caption?: string
    }
  | { type: 'chart'; spec: ChartSpec; caption?: string }
  | { type: 'code'; language?: string; text: string; caption?: string }
  | { type: 'callout'; tone: ViewTone; title?: string; text: string }
  | { type: 'kv'; rows: { label: string; value: string }[] }
  | { type: 'tree'; nodes: TreeNode[] }
  | { type: 'diff'; before: string; after: string; language?: string }
  | { type: 'timeline'; events: TimelineEvent[] }
  | { type: 'link'; href: string; text: string }

export interface ViewDoc {
  version: 1
  blocks: ViewBlock[]
}

const BLOCK_TYPES = new Set([
  'markdown',
  'section',
  'stack',
  'row',
  'table',
  'chart',
  'code',
  'callout',
  'kv',
  'tree',
  'diff',
  'timeline',
  'link',
])

export const VIEW_LIMITS = {
  /** Host safety, not an agent budget: a render larger than this is refused. */
  bytes: 2 * 1024 * 1024,
  depth: 12,
  blocks: 2000,
  rows: 20_000,
  nodes: 10_000,
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function cell(value: unknown): ViewCell {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function block(value: unknown, depth: number, count: { n: number }): ViewBlock | null {
  if (!isRecord(value) || depth > VIEW_LIMITS.depth) return null
  count.n += 1
  if (count.n > VIEW_LIMITS.blocks) return null
  const type = text(value.type)
  if (!type || !BLOCK_TYPES.has(type)) return null

  if (type === 'markdown') {
    const body = text(value.text)
    return body === null ? null : { type, text: body }
  }
  if (type === 'section' || type === 'stack' || type === 'row') {
    const blocks = Array.isArray(value.blocks)
      ? value.blocks
          .map((item) => block(item, depth + 1, count))
          .filter((item): item is ViewBlock => item !== null)
      : []
    if (type === 'section') {
      const title = text(value.title)
      return { type, blocks, ...(title ? { title } : {}) }
    }
    if (type === 'stack') {
      const gap =
        value.gap === 's' || value.gap === 'm' || value.gap === 'l' ? value.gap : undefined
      return { type, blocks, ...(gap ? { gap } : {}) }
    }
    return { type, blocks }
  }
  if (type === 'table') {
    const columns: ViewColumn[] = []
    if (Array.isArray(value.columns))
      for (const column of value.columns) {
        if (!isRecord(column)) continue
        const key = text(column.key)
        if (!key) continue
        const label = text(column.label)
        const format =
          column.format === 'number' ||
          column.format === 'bytes' ||
          column.format === 'percent' ||
          column.format === 'date'
            ? column.format
            : 'text'
        columns.push({ key, ...(label ? { label } : {}), format })
      }
    const rows = Array.isArray(value.rows)
      ? value.rows
          .slice(0, VIEW_LIMITS.rows)
          .filter(isRecord)
          .map((row) =>
            Object.fromEntries(columns.map((column) => [column.key, cell(row[column.key])])),
          )
      : []
    if (!columns.length) return null
    const caption = text(value.caption)
    return { type, columns, rows, ...(caption ? { caption } : {}) }
  }
  if (type === 'chart') {
    if (!isRecord(value.spec)) return null
    const spec = value.spec
    const mark = spec.mark
    if (mark !== 'bar' && mark !== 'line' && mark !== 'area' && mark !== 'point') return null
    const x = text(spec.x)
    const y = text(spec.y)
    if (!x || !y || !Array.isArray(spec.data)) return null
    const data = spec.data
      .slice(0, VIEW_LIMITS.rows)
      .filter(isRecord)
      .map((row) => Object.fromEntries(Object.entries(row).map(([key, item]) => [key, cell(item)])))
    const series = text(spec.series)
    const xLabel = text(spec.xLabel)
    const yLabel = text(spec.yLabel)
    return {
      type,
      spec: {
        mark,
        x,
        y,
        data,
        ...(series ? { series } : {}),
        ...(xLabel ? { xLabel } : {}),
        ...(yLabel ? { yLabel } : {}),
      },
      ...(text(value.caption) ? { caption: text(value.caption)! } : {}),
    }
  }
  if (type === 'code') {
    const body = text(value.text)
    if (body === null) return null
    return {
      type,
      text: body,
      ...(text(value.language) ? { language: text(value.language)! } : {}),
      ...(text(value.caption) ? { caption: text(value.caption)! } : {}),
    }
  }
  if (type === 'callout') {
    const body = text(value.text)
    if (body === null) return null
    const tone =
      value.tone === 'warn' || value.tone === 'danger' || value.tone === 'ok' ? value.tone : 'info'
    return { type, tone, text: body, ...(text(value.title) ? { title: text(value.title)! } : {}) }
  }
  if (type === 'kv') {
    const rows = Array.isArray(value.rows)
      ? value.rows
          .filter(isRecord)
          .map((row) => ({ label: text(row.label) ?? '', value: text(row.value) ?? '' }))
          .filter((row) => row.label)
      : []
    return { type, rows }
  }
  if (type === 'tree') {
    const nodes = Array.isArray(value.nodes)
      ? value.nodes
          .slice(0, VIEW_LIMITS.nodes)
          .map(node)
          .filter((item): item is TreeNode => item !== null)
      : []
    return { type, nodes }
  }
  if (type === 'diff') {
    const before = text(value.before)
    const after = text(value.after)
    if (before === null || after === null) return null
    return {
      type,
      before,
      after,
      ...(text(value.language) ? { language: text(value.language)! } : {}),
    }
  }
  if (type === 'timeline') {
    const events = Array.isArray(value.events)
      ? value.events
          .filter(isRecord)
          .map((event) => {
            const at = text(event.at)
            const title = text(event.title)
            if (!at || !title) return null
            const tone =
              event.tone === 'warn' || event.tone === 'danger' || event.tone === 'ok'
                ? event.tone
                : undefined
            return {
              at,
              title,
              ...(text(event.detail) ? { detail: text(event.detail)! } : {}),
              ...(tone ? { tone } : {}),
            }
          })
          .filter((event): event is TimelineEvent => event !== null)
      : []
    return { type, events }
  }
  // link
  const href = text(value.href)
  const label = text(value.text)
  if (!href || !label || !/^https?:\/\//i.test(href)) return null
  return { type: 'link', href, text: label }
}

function node(value: unknown): TreeNode | null {
  if (!isRecord(value)) return null
  const label = text(value.label)
  if (!label) return null
  const children = Array.isArray(value.children)
    ? value.children
        .slice(0, VIEW_LIMITS.nodes)
        .map(node)
        .filter((item): item is TreeNode => item !== null)
    : undefined
  return {
    label,
    ...(text(value.detail) ? { detail: text(value.detail)! } : {}),
    ...(children?.length ? { children } : {}),
  }
}

/** Validate and shape a render document; null when it is not one. */
export function viewDoc(value: unknown): ViewDoc | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.blocks)) return null
  if (value.blocks.length > VIEW_LIMITS.blocks) return null
  if (JSON.stringify(value).length > VIEW_LIMITS.bytes) return null
  const count = { n: 0 }
  const blocks = value.blocks
    .map((item) => block(item, 0, count))
    .filter((item): item is ViewBlock => item !== null)
  return blocks.length ? { version: 1, blocks } : null
}

/** Plain text of a view, for search and Markdown export. */
export function viewText(doc: ViewDoc): string {
  const out: string[] = []
  const walk = (blocks: ViewBlock[]) => {
    for (const item of blocks) {
      if (item.type === 'markdown' || item.type === 'code') out.push(item.text)
      else if (item.type === 'callout')
        out.push(item.title ? `${item.title}\n${item.text}` : item.text)
      else if (item.type === 'section' || item.type === 'stack' || item.type === 'row')
        walk(item.blocks)
      else if (item.type === 'table') {
        out.push(item.columns.map((column) => column.label ?? column.key).join(' | '))
        for (const row of item.rows)
          out.push(item.columns.map((column) => String(row[column.key] ?? '')).join(' | '))
      } else if (item.type === 'kv')
        out.push(item.rows.map((row) => `${row.label}: ${row.value}`).join('\n'))
      else if (item.type === 'tree') {
        const walkNode = (node: TreeNode, depth: number) => {
          out.push(`${'  '.repeat(depth)}${node.label}${node.detail ? ` — ${node.detail}` : ''}`)
          for (const child of node.children ?? []) walkNode(child, depth + 1)
        }
        for (const node of item.nodes) walkNode(node, 0)
      } else if (item.type === 'timeline')
        out.push(
          item.events
            .map((event) => `${event.at} ${event.title}${event.detail ? ` — ${event.detail}` : ''}`)
            .join('\n'),
        )
      else if (item.type === 'diff') out.push(`${item.before}\n---\n${item.after}`)
      else if (item.type === 'link') out.push(`${item.text} ${item.href}`)
    }
  }
  walk(doc.blocks)
  return out.join('\n\n')
}
