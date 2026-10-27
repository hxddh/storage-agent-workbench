/**
 * The deterministic sentence above a model-free account check.
 *
 * It only uses names and counts already present in the survey views. A model
 * is not asked to summarize, so this sentence cannot name a bucket the tools
 * did not return.
 */
import type { Lang, ToolView } from './contract'

type SurveyView = Extract<ToolView, { kind: 'survey' }>

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const

function joinNames(names: string[], lang: Lang): string {
  const code = names.map((name) => `\`${name}\``).join(lang === 'zh' ? '、' : ', ')
  if (!code) return ''
  return lang === 'zh' ? `${code} 等` : ` including ${code}`
}

export function auditVerdict(
  surveys: readonly SurveyView[],
  access: { examined: number; total: number } | undefined,
  lang: Lang,
): string {
  const open = surveys.flatMap((survey) => survey.issues).filter((issue) => issue.status === 'open')
  const high = open.filter((issue) => issue.severity === 'high').length
  const buckets = [
    ...new Set(
      open
        .filter((issue) => issue.bucket)
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
        .map((issue) => issue.bucket),
    ),
  ].slice(0, 3)
  const processed = surveys.reduce((sum, survey) => sum + survey.coverage.processed, 0)
  const blind = surveys.reduce(
    (sum, survey) => sum + survey.coverage.denied.length + survey.coverage.unknown.length,
    0,
  )
  const pending = surveys.reduce((sum, survey) => sum + (survey.coverage.pending ?? 0), 0)
  // A survey stops selecting at its cap. The page must not turn the rest of
  // the account into "no issue found"; count the buckets outside the run.
  const truncated = surveys.reduce(
    (sum, survey) =>
      sum +
      (survey.coverage.truncated
        ? Math.max(
            0,
            survey.coverage.visible - survey.coverage.processed - (survey.coverage.pending ?? 0),
          )
        : 0),
    0,
  )
  const second: string[] = []
  const accessLine =
    access && access.examined < access.total
      ? lang === 'zh'
        ? `访问路径检查了 ${access.examined}/${access.total} 个桶。`
        : `Access paths covered ${access.examined} of ${access.total} buckets.`
      : null
  if (blind || pending) {
    second.push(
      lang === 'zh'
        ? `另有 ${blind + pending} 个桶未能完整读取。`
        : `${blind + pending} bucket${blind + pending === 1 ? '' : 's'} could not be read completely.`,
    )
  }
  if (truncated) {
    second.push(
      lang === 'zh'
        ? `还有 ${truncated} 个桶超出本次读取范围。`
        : `${truncated} bucket${truncated === 1 ? '' : 's'} were outside this run.`,
    )
  }
  if (accessLine) second.push(accessLine)

  if (open.length) {
    const first =
      lang === 'zh'
        ? `${processed} 个桶中有 ${open.length} 项未解决风险${high ? `（${high} 项高风险）` : ''}${joinNames(buckets, lang)}。`
        : `${open.length} risk${open.length === 1 ? '' : 's'}${high ? ` (${high} high)` : ''} ${open.length === 1 ? 'is' : 'are'} open across ${processed} bucket${processed === 1 ? '' : 's'}${joinNames(buckets, lang)}.`
    return [first, second.join(' ')].filter(Boolean).join(' ')
  }
  if (blind || pending || truncated) {
    const first =
      lang === 'zh'
        ? `这次读取覆盖了 ${processed} 个桶，但还不能下结论：有桶未能完整读取。`
        : `The reading covered ${processed} bucket${processed === 1 ? '' : 's'}, but it cannot close the question because a read was incomplete.`
    return [first, ...second].join(' ')
  }
  const clean =
    lang === 'zh'
      ? `已检查 ${processed} 个桶，没有未解决的风险。`
      : `No open risk was found across ${processed} bucket${processed === 1 ? '' : 's'}.`
  return [clean, ...(accessLine ? [accessLine] : [])].join(' ')
}
