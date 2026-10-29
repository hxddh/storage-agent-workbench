/**
 * Entry builders for tests: a run as the window receives it. Not imported by
 * application code.
 */
import type { IssueRow, ToolName, ToolView, UiEntry } from './contract'

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

export function issue(
  bucket: string,
  code = 'public_exposure',
  overrides: Partial<IssueRow> = {},
): IssueRow {
  return {
    id: `i-${bucket}-${code}`,
    provider: 'p1',
    bucket,
    code,
    severity: code === 'public_exposure' ? 'high' : 'medium',
    status: 'open',
    title: code === 'public_exposure' ? 'Bucket is publicly accessible' : 'No default encryption',
    detail: null,
    openedAt: at(),
    lastSeenAt: at(),
    recurred: 0,
    ...overrides,
  }
}

type SurveyView = Extract<ToolView, { kind: 'survey' }>

export function survey(
  buckets: string[],
  overrides: Partial<Omit<SurveyView, 'coverage'>> & {
    coverage?: Partial<SurveyView['coverage']>
  } = {},
): Extract<ToolView, { kind: 'survey' }> {
  const { coverage, ...rest } = overrides
  return {
    kind: 'survey',
    provider: 'Demo',
    providerId: 'p1',
    buckets: { columns: ['Bucket', 'Public'], rows: buckets.map((name) => [name, 'no']) },
    issues: [],
    coverage: {
      visible: buckets.length,
      processed: buckets.length,
      truncated: false,
      pending: 0,
      denied: [],
      unknown: [],
      gone: [],
      ...coverage,
    },
    changed: { opened: 0, resolved: 0, recurred: 0 },
    ...rest,
  }
}
