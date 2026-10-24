import { aspectsOf, decide, reviewFindings } from '../estate/rules'
import { readBucket, rememberable } from '../s3/facts'
import { agentTool, assertInScope, bucketParam, providerParam, type ToolDeps, Type } from './policy'

const ASPECTS = ['security', 'lifecycle', 'observability'] as const

export function configTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'config',
    description:
      'Review one bucket’s configuration read-only in depth and decide its Issues: exposure (policy, ACL, public access block), CORS, encryption, lifecycle and cleanup, or logging and tags.',
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
      const aspect = (args.aspect ?? 'security') as (typeof ASPECTS)[number]
      run.progress(`Reading ${aspect}`)
      const facts = await readBucket(client, args.bucket, {
        aspects: new Set([aspect]),
        signal: run.signal,
        regional: run.regional,
        defaultRegion: config.region,
      })
      if (facts.head === 'missing') throw new Error(`Bucket '${args.bucket}' does not exist.`)

      // Only the rules this aspect can see are applied; the others keep their state.
      const wanted = new Set(aspectsOf(aspect))
      const decisions = Object.fromEntries(
        Object.entries(decide(facts, deps.lang())).filter(([code]) => wanted.has(code)),
      )
      const { observations } = await deps.estate.apply(
        config.id,
        args.bucket,
        decisions,
        run.conversationId,
      )
      const previous = (await deps.estate.postureOf(config.id, args.bucket)) ?? {}
      await deps.db.upsertBucket(
        config.id,
        args.bucket,
        { ...previous, ...pick(rememberable(facts), REMEMBERED[aspect]) },
        facts.region,
      )

      const { findings, passed } = reviewFindings(facts, aspect, deps.lang())
      const problems = findings.filter((finding) => finding.severity !== 'blind')
      const blind = findings.filter((finding) => finding.severity === 'blind')
      const lines = problems.length
        ? problems.slice(0, 10).map((f) => `[${f.severity}] ${f.title}: ${f.detail}`)
        : [`No problems in the ${aspect} review.`]
      if (blind.length)
        lines.push(`Blind (undecided, not clean): ${blind.map((f) => f.title).join('; ')}.`)
      if (passed) lines.push(`${passed} rule(s) proved clean.`)
      return {
        model: lines.join('\n'),
        note: problems.length
          ? `${problems.length} finding${problems.length === 1 ? '' : 's'}`
          : blind.length
            ? 'partly blind'
            : 'clean',
        view: {
          kind: 'config' as const,
          bucket: args.bucket,
          providerId: config.id,
          aspect,
          findings,
          observations,
        },
      }
    },
  })
}

/** The remembered posture keys each aspect reads; the others keep their last value. */
const REMEMBERED: Record<(typeof ASPECTS)[number], string[]> = {
  security: [
    'region',
    'publicly_exposed',
    'encryption_status',
    'public_access_block_status',
    'policy_status',
    'acl_status',
    'cors_status',
    'object_ownership',
    'versioning_status',
    'versioning_enabled',
  ],
  lifecycle: [
    'region',
    'versioning_status',
    'versioning_enabled',
    'lifecycle_status',
    'lifecycle_abort_mpu',
    'lifecycle_noncurrent',
  ],
  observability: ['region', 'logging_status'],
}

function pick(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]))
}
