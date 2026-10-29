/**
 * Scripted runs: what an account check and a re-check read, and the answer
 * they write from those reads.
 *
 * A scripted run calls the same registered tools as the model, through the same
 * `agentTool()`, and leaves the same tool entries. Only the sentence at the end
 * is a template: it names buckets and counts already present in the survey
 * views and cites the call that showed them, so it passes the same validation
 * as a model's answer.
 */
import type { ChangePlan, Lang, ReverifyReport, ToolView, UiEntry } from '@shared/contract'
import { aspectOfCode } from '../estate/rules'

type SurveyView = Extract<ToolView, { kind: 'survey' }>
export type Aspect = 'security' | 'lifecycle' | 'observability' | 'access'

/** Access paths are examined for this many buckets per account. */
export const CHECK_ACCESS_BUCKETS = 24
/** A re-check re-reads at most this many buckets per account (the survey's own limit). */
export const RECHECK_BUCKETS = 50

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const

/** The buckets whose access paths a check examines: open Issues first, then the rest. */
export function accessTargets(view: SurveyView): string[] {
  const names = view.buckets.rows.map((row) => String(row[0] ?? '')).filter(Boolean)
  const risky = view.issues
    .filter((issue) => issue.bucket && issue.status === 'open')
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((issue) => issue.bucket)
  return [...new Set([...risky, ...names])].slice(0, CHECK_ACCESS_BUCKETS)
}

function cite(id: string | undefined): string {
  return id ? ` [1](#ev-${encodeURIComponent(id)})` : ''
}

function names(list: string[], lang: Lang): string {
  const code = list.map((name) => `\`${name}\``).join(lang === 'zh' ? '、' : ', ')
  if (!code) return ''
  return lang === 'zh' ? `，涉及 ${code} 等` : `, including ${code}`
}

/** The check's answer. It never closes a question a read left open. */
export function checkAnswer(
  surveys: readonly { view: SurveyView; evidenceId?: string }[],
  access: { examined: number; total: number },
  failedAccounts: number,
  lang: Lang,
): string {
  const zh = lang === 'zh'
  if (!surveys.length)
    return zh ? '这次检查没有读到任何存储桶。' : 'The account check could not read any bucket.'
  const paragraphs: string[] = []
  for (const { view, evidenceId } of surveys) {
    const open = view.issues.filter((issue) => issue.status === 'open')
    const high = open.filter((issue) => issue.severity === 'high').length
    const risky = [
      ...new Set(
        open
          .filter((issue) => issue.bucket)
          .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
          .map((issue) => issue.bucket),
      ),
    ].slice(0, 3)
    const { processed, visible, denied, unknown } = view.coverage
    const pending = view.coverage.pending ?? 0
    const outside = view.coverage.truncated ? Math.max(0, visible - processed - pending) : 0
    const blind = denied.length + unknown.length + pending
    const parts: string[] = []
    if (open.length)
      parts.push(
        zh
          ? `${processed} 个桶中有 ${open.length} 项未解决风险${high ? `（${high} 项高风险）` : ''}${names(risky, lang)}。`
          : `${open.length} risk${open.length === 1 ? '' : 's'}${high ? ` (${high} high)` : ''} ${open.length === 1 ? 'is' : 'are'} open across ${processed} bucket${processed === 1 ? '' : 's'}${names(risky, lang)}.`,
      )
    else if (blind || outside)
      parts.push(
        zh
          ? `这次读取覆盖了 ${processed} 个桶，但还不能下结论：有桶未能完整读取。`
          : `The reading covered ${processed} bucket${processed === 1 ? '' : 's'}, but it cannot close the question because a read was incomplete.`,
      )
    else
      parts.push(
        zh
          ? `已检查 ${processed} 个桶，没有未解决的风险。`
          : `No open risk was found across ${processed} bucket${processed === 1 ? '' : 's'}.`,
      )
    if (blind)
      parts.push(
        zh
          ? `另有 ${blind} 个桶未能完整读取。`
          : `${blind} bucket${blind === 1 ? '' : 's'} could not be read completely.`,
      )
    if (outside)
      parts.push(
        zh
          ? `还有 ${outside} 个桶超出本次读取范围。`
          : `${outside} bucket${outside === 1 ? '' : 's'} were outside this run.`,
      )
    paragraphs.push(`${parts.join(' ')}${cite(evidenceId)}`)
  }
  if (access.examined < access.total)
    paragraphs.push(
      zh
        ? `访问路径检查了 ${access.examined}/${access.total} 个桶。`
        : `Access paths covered ${access.examined} of ${access.total} buckets.`,
    )
  if (failedAccounts)
    paragraphs.push(
      zh
        ? `${failedAccounts} 个账号未能读取。`
        : `${failedAccounts} account${failedAccounts === 1 ? '' : 's'} could not be read.`,
    )
  return paragraphs.join('\n\n')
}

export interface RecheckTargets {
  /** Per account, the buckets the task read and the aspects it read them for. */
  accounts: Map<string, Map<string, Set<Aspect>>>
  plan: ChangePlan | null
  planProviderId: string | null
}

/** What a re-check replays: every bucket the task read, by account and aspect. */
export function recheckTargets(entries: readonly UiEntry[]): RecheckTargets {
  const accounts = new Map<string, Map<string, Set<Aspect>>>()
  const add = (providerId: string, buckets: Iterable<string>, aspects: Iterable<Aspect>) => {
    const map = accounts.get(providerId) ?? new Map<string, Set<Aspect>>()
    for (const bucket of buckets) {
      if (!bucket) continue
      const set = map.get(bucket) ?? new Set<Aspect>()
      for (const aspect of aspects) set.add(aspect)
      map.set(bucket, set)
    }
    accounts.set(providerId, map)
  }
  let plan: ChangePlan | null = null
  let planProviderId: string | null = null
  for (const entry of entries) {
    if (entry.kind !== 'tool' || entry.status !== 'done' || !entry.view) continue
    const view = entry.view
    const rows = (table: { rows: (string | number | null)[][] } | null | undefined) =>
      (table?.rows ?? []).map((row) => String(row[0] ?? ''))
    if (view.kind === 'change' && view.plan && view.providerId) {
      plan = view.plan
      planProviderId = view.providerId
      const aspects = new Set<Aspect>()
      for (const code of view.plan.steps.flatMap((step) => step.codes)) {
        const aspect = aspectOfCode(code)
        if (aspect) aspects.add(aspect)
      }
      add(
        view.providerId,
        view.plan.steps.map((step) => step.bucket),
        aspects.size ? aspects : ['security'],
      )
    } else if (view.kind === 'survey' && view.providerId)
      add(view.providerId, rows(view.buckets), ['security', 'lifecycle'])
    else if (view.kind === 'config' && view.providerId)
      add(view.providerId, [view.bucket], [view.aspect ?? 'security'])
    else if (view.kind === 'estate' && view.providerId)
      add(view.providerId, rows(view.buckets), ['security', 'lifecycle'])
    else if (view.kind === 'query' && view.providerId && view.buckets)
      add(view.providerId, view.buckets, ['security', 'lifecycle'])
  }
  return { accounts, plan, planProviderId }
}

/** The re-check's answer: what changed, and what the plan comparison found. */
export function recheckAnswer(report: ReverifyReport, evidenceId: string | undefined, lang: Lang) {
  const zh = lang === 'zh'
  const parts: string[] = [
    zh
      ? `重新读取了 ${report.checked} 个桶${report.skipped ? `，${report.skipped} 个未读取` : ''}${report.truncated ? '（已截断）' : ''}。`
      : `Re-read ${report.checked} bucket${report.checked === 1 ? '' : 's'}${report.skipped ? `; ${report.skipped} could not be read` : ''}${report.truncated ? ' (truncated)' : ''}.`,
    report.changes.length
      ? zh
        ? `${report.changes.length} 项结论变化：${report.opened} 项新开，${report.resolved} 项已解决，${report.undecided} 项无法判断。`
        : `${report.changes.length} conclusion${report.changes.length === 1 ? '' : 's'} changed: ${report.opened} opened, ${report.resolved} resolved, ${report.undecided} undecided.`
      : zh
        ? '结论没有变化。'
        : 'No conclusion changed.',
  ]
  if (report.plan)
    parts.push(
      zh
        ? `变更计划：${report.plan.confirmed} 步已确认，${report.plan.notApplied} 步未应用，${report.plan.unknown} 步未知。`
        : `Change plan: ${report.plan.confirmed} confirmed, ${report.plan.notApplied} not applied, ${report.plan.unknown} unknown.`,
    )
  return `${parts.join(' ')}${cite(evidenceId)}`
}
