/**
 * One task, one brief.
 *
 * The window does not replay a chat: it projects the task's tool results into a
 * page — a verdict, the findings those tools proved, one data section, the fix,
 * and the checks that produced them. The model writes the verdict; everything
 * else here is deterministic, so the page cannot contradict the tools.
 *
 * Shared by the renderer and the main process (search indexes the same facts).
 */
import type {
  AttachmentRef,
  ConfigFinding,
  IssueRow,
  Severity,
  ToolName,
  ToolView,
  UiEntry,
} from './contract'

export interface BriefFinding {
  key: string
  group: string
  provider: string | null
  bucket: string
  title: string
  detail: string | null
  severity: Severity
  sourceId: string
  sourceName: ToolName
  at: string
}

export interface BriefData {
  key: string
  kind: ToolView['kind']
  title: string
  view: ToolView
  sourceId: string
  at: string
}

export interface BriefFix {
  key: string
  sourceId: string
  view: Extract<ToolView, { kind: 'fix' }>
  at: string
}

export interface BriefCheck {
  id: string
  name: ToolName
  target: string
  status: 'running' | 'done' | 'failed' | 'refused' | 'stopped'
  note: string | null
  ms: number | null
  at: string
  view: ToolView | null
}

export interface BriefCoverage {
  provider: string
  visible: number
  processed: number
  denied: string[]
  unknown: string[]
  truncated: boolean
  at: string
}

export interface BriefQuestion {
  id: string
  text: string
  at: string
  attachments: AttachmentRef[]
}

export interface BriefNotice {
  id: string
  text: string
  tone: 'info' | 'warn' | 'error'
  action?: 'retry' | 'continue'
}

export interface Brief {
  verdict: { text: string; at: string; streaming: boolean } | null
  findings: BriefFinding[]
  data: BriefData | null
  fix: BriefFix | null
  checks: BriefCheck[]
  coverage: BriefCoverage | null
  questions: BriefQuestion[]
  notices: BriefNotice[]
  /** Sum of the current turn's tool durations; null while it has none. */
  durationMs: number | null
  /** The freshest successful read in the task, for the "checked …" line. */
  lastReadAt: string | null
  /** Newest entry in the task, for ordering and the live line. */
  lastAt: string | null
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
const DATA_KINDS = new Set<ToolView['kind']>(['survey', 'buckets', 'objects', 'object', 'analyze'])
const READ_KINDS = new Set<ToolName>([
  'survey',
  'buckets',
  'objects',
  'object',
  'config',
  'probe',
  'estate',
])

function later(a: string | null, b: string): string {
  if (!a) return b
  return Date.parse(b) > Date.parse(a) ? b : a
}

function issueFinding(issue: IssueRow, check: BriefCheck): BriefFinding {
  return {
    key: `issue:${issue.id}`,
    group: `${issue.bucket}:${issue.code}`,
    provider: check.name === 'survey' || check.name === 'estate' ? check.target || null : null,
    bucket: issue.bucket,
    title: issue.title,
    detail: issue.recurred > 0 ? `seen ${issue.recurred + 1}×` : null,
    severity: issue.severity,
    sourceId: check.id,
    sourceName: check.name,
    at: check.at,
  }
}

function configFinding(finding: ConfigFinding, bucket: string, check: BriefCheck): BriefFinding {
  return {
    key: `config:${bucket}:${finding.code ?? finding.title}`,
    group: `${bucket}:${finding.code ?? finding.title.toLowerCase()}`,
    provider: null,
    bucket,
    title: finding.title,
    detail: finding.detail || null,
    severity: finding.severity === 'ok' ? 'low' : finding.severity,
    sourceId: check.id,
    sourceName: check.name,
    at: check.at,
  }
}

function findingsOf(check: BriefCheck): BriefFinding[] {
  const view = check.view
  if (!view) return []
  if (view.kind === 'survey') return view.issues.map((issue) => issueFinding(issue, check))
  if (view.kind === 'estate') return view.issues.map((issue) => issueFinding(issue, check))
  if (view.kind === 'config') {
    return view.findings
      .filter((finding) => finding.severity !== 'ok')
      .map((finding) => configFinding(finding, view.bucket, check))
  }
  return []
}

export function buildBrief(
  entries: readonly UiEntry[],
  live?: {
    tools: {
      callId: string
      name: ToolName
      target: string
      note: string | null
      startedAt: string
    }[]
    text: string | null
    startedAt: string
  } | null,
): Brief {
  const questions: BriefQuestion[] = []
  const checks: BriefCheck[] = []
  const notices: BriefNotice[] = []
  const answers: { text: string; at: string }[] = []
  let lastAt: string | null = null
  let lastUserIndex = -1

  entries.forEach((entry, index) => {
    if (entry.at) lastAt = later(lastAt, entry.at)
    if (entry.kind === 'user') {
      questions.push({
        id: entry.id,
        text: entry.text,
        at: entry.at,
        attachments: entry.attachments,
      })
      lastUserIndex = index
    } else if (entry.kind === 'answer') {
      if (entry.text.trim()) answers.push({ text: entry.text.trim(), at: entry.at })
    } else if (entry.kind === 'tool') {
      checks.push({
        id: entry.id,
        name: entry.name,
        target: entry.target,
        status: entry.status,
        note: entry.note,
        ms: entry.ms,
        at: entry.at,
        view: entry.view,
      })
    } else if (entry.kind === 'notice') {
      if (index > lastUserIndex) {
        notices.push({
          id: entry.id,
          text: entry.text,
          tone: entry.tone,
          ...(entry.action ? { action: entry.action } : {}),
        })
      }
    }
  })

  for (const tool of live?.tools ?? []) {
    checks.push({
      id: `live:${tool.callId}`,
      name: tool.name,
      target: tool.target,
      status: 'running',
      note: tool.note,
      ms: null,
      at: tool.startedAt,
      view: null,
    })
  }

  // An Issue and the review finding that produced it are the same problem. Group
  // by rule code and bucket, keep the Issue (it carries the rule's severity and
  // recurrence), and borrow the review's detail when the Issue has none.
  const groups = new Map<string, BriefFinding>()
  for (const check of checks) {
    for (const finding of findingsOf(check)) {
      const existing = groups.get(finding.group)
      if (!existing) {
        groups.set(finding.group, finding)
        continue
      }
      if (finding.key.startsWith('issue:') && !existing.key.startsWith('issue:')) {
        groups.set(finding.group, { ...finding, detail: finding.detail ?? existing.detail })
        continue
      }
      if (!existing.detail && finding.detail) existing.detail = finding.detail
    }
  }
  const findings = [...groups.values()]
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      Date.parse(b.at) - Date.parse(a.at),
  )

  let data: BriefData | null = null
  let fix: BriefFix | null = null
  let coverage: BriefCoverage | null = null
  let lastReadAt: string | null = null
  for (const check of checks) {
    if (check.status !== 'done' || !check.view) continue
    if (READ_KINDS.has(check.name) && check.at) lastReadAt = later(lastReadAt, check.at)
    if (DATA_KINDS.has(check.view.kind)) {
      data = {
        key: check.id,
        kind: check.view.kind,
        title: check.target,
        view: check.view,
        sourceId: check.id,
        at: check.at,
      }
    }
    if (check.view.kind === 'fix') {
      fix = { key: check.id, sourceId: check.id, view: check.view, at: check.at }
    }
    if (check.view.kind === 'survey') {
      coverage = {
        provider: check.view.provider,
        visible: check.view.coverage.visible,
        processed: check.view.coverage.processed,
        denied: check.view.coverage.denied,
        unknown: check.view.coverage.unknown,
        truncated: check.view.coverage.truncated,
        at: check.at,
      }
    }
  }

  const current = checks.filter((check) => {
    const question = questions.at(-1)
    if (!question) return true
    return !question.at || !check.at || Date.parse(check.at) >= Date.parse(question.at)
  })
  const measured = current.filter((check) => check.status !== 'running' && check.ms !== null)
  const durationMs = measured.length
    ? measured.reduce((total, check) => total + (check.ms ?? 0), 0)
    : null

  const streamed = live?.text?.trim() ? live.text.trim() : null
  const lastAnswer = answers.at(-1) ?? null
  const verdict = streamed
    ? { text: streamed, at: live?.startedAt ?? new Date().toISOString(), streaming: true }
    : lastAnswer
      ? { text: lastAnswer.text, at: lastAnswer.at, streaming: false }
      : null

  return {
    verdict,
    findings,
    data,
    fix,
    checks,
    coverage,
    questions,
    notices,
    durationMs,
    lastReadAt,
    lastAt: live?.startedAt ? later(lastAt, live.startedAt) : lastAt,
  }
}

/** Text the search index stores for a task's brief. */
export function briefSearchText(
  brief: Brief,
): { entryId: string; kind: string; text: string; at: string }[] {
  const docs: { entryId: string; kind: string; text: string; at: string }[] = []
  for (const finding of brief.findings) {
    docs.push({
      entryId: `f:${finding.key}`,
      kind: 'finding',
      text: [finding.provider, finding.bucket, finding.title, finding.detail]
        .filter(Boolean)
        .join(' · '),
      at: finding.at,
    })
  }
  if (brief.verdict) {
    const latest = brief.checks.reduce<string | null>((at, check) => later(at, check.at), null)
    docs.push({
      entryId: 'verdict',
      kind: 'answer',
      text: brief.verdict.text,
      at: latest ?? brief.verdict.at,
    })
  }
  return docs
}
