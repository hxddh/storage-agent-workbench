/**
 * Entry builders for tests: a run as the window receives it. Not imported by
 * application code.
 */
import type { ToolName, ToolView, UiEntry } from './contract'

let seq = 0
export function at(offset = 0): string {
  return new Date(Date.UTC(2026, 0, 1) + offset * 1000).toISOString()
}

export function request(text = 'Which buckets are public?', id = `u${seq++}`): UiEntry {
  return { id, kind: 'user', at: at(seq), text, attachments: [] }
}

export function tool(
  name: ToolName,
  view: ToolView | null,
  options: {
    id?: string
    target?: string
    status?: 'done' | 'failed' | 'running'
    at?: string
  } = {},
): UiEntry {
  const id = options.id ?? `t${seq++}`
  return {
    id,
    kind: 'tool',
    at: options.at ?? at(seq),
    name,
    target: options.target ?? '',
    status: options.status ?? 'done',
    note: null,
    ms: 10,
    view,
    callId: id,
    evidenceId: id,
  }
}

export function answer(text: string): UiEntry {
  return { id: `a${seq++}`, kind: 'answer', at: at(seq), text }
}

/** A `buckets` result listing these names. */
export function buckets(names: string[]): Extract<ToolView, { kind: 'buckets' }> {
  return {
    kind: 'buckets',
    rows: { columns: ['Bucket', 'Created'], rows: names.map((name) => [name, '2026-01-01']) },
  }
}
