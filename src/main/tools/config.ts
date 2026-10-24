import { codeForReviewTitle, evaluateReview } from '../estate/rules'
import { reviewLifecycle, reviewObservability, reviewSecurity } from '../s3/review'
import { agentTool, assertInScope, bucketParam, providerParam, type ToolDeps, Type } from './policy'

const ASPECTS = ['security', 'lifecycle', 'observability'] as const

export function configTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'config',
    description:
      'Review one bucket’s configuration read-only and open Issues for what the rules decide: public exposure, policy, CORS, encryption, public access block, lifecycle and cleanup.',
    parameters: Type.Object({
      provider_id: providerParam,
      bucket: bucketParam,
      aspect: Type.Optional(
        Type.Union(
          ASPECTS.map((aspect) => Type.Literal(aspect)),
          { description: 'security (default), lifecycle, or observability.' },
        ),
      ),
    }),
    timeoutMs: 90_000,
    target: (args) => args.bucket,
    run: async (args, run) => {
      const { config, client } = await run.provider(args.provider_id)
      assertInScope(config, args.bucket)
      const aspect = (args.aspect ?? 'security') as 'security' | 'lifecycle' | 'observability'
      run.progress(`Reviewing ${args.bucket} (${aspect})`)
      const findings =
        aspect === 'lifecycle'
          ? await reviewLifecycle(client, args.bucket)
          : aspect === 'observability'
            ? await reviewObservability(client, args.bucket)
            : await reviewSecurity(client, args.bucket)
      if (aspect !== 'observability') {
        const { verdicts } = evaluateReview(
          aspect === 'lifecycle' ? 'lifecycle' : 'security',
          findings,
        )
        await deps.estate.apply(config.id, args.bucket, verdicts, run.conversationId)
      }
      const problems = findings.filter((finding) => finding.severity !== 'ok')
      const passed = findings.length - problems.length
      const lines = problems.length
        ? problems.slice(0, 8).map((f) => `[${f.severity}] ${f.title}: ${f.detail}`)
        : [`No problems found in the ${aspect} review.`]
      if (passed) lines.push(`${passed} check(s) passed.`)
      return {
        model: lines.join('\n'),
        note: problems.length
          ? `${problems.length} finding${problems.length === 1 ? '' : 's'}`
          : 'clean',
        view: {
          kind: 'config' as const,
          bucket: args.bucket,
          findings: problems.map((finding) => ({
            ...finding,
            code: codeForReviewTitle(finding.title),
          })),
        },
      }
    },
  })
}
