import { aspectsOf, decide, reviewFindings } from '../estate/rules'
import { type AccessSession, readAccess } from '../s3/access'
import { readAccount, UNREAD_ACCOUNT } from '../s3/account'
import { readBucket, rememberable } from '../s3/facts'
import { accessPermissionGaps, permissionGaps } from '../s3/permissions'
import { agentTool, assertInScope, bucketParam, providerParam, type ToolDeps, Type } from './policy'

const ASPECTS = ['security', 'lifecycle', 'observability', 'access'] as const

export function configTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'config',
    description:
      'Review one bucket read-only in depth: exposure (policy, ACL, public access block), CORS, encryption, lifecycle and cleanup, logging and tags, or access (who can reach it, from bucket policy, ACL, IAM, inherited SCPs when Organizations permits, KMS key policy and Access Analyzer). Access rows are grants, not one merged authorization verdict; it reports principal coverage, undecided conditions and truncation, and a denied source is unread, not an empty grant list. Service principals, federated identities and some external policies stay outside the enumerated evidence.',
    parameters: Type.Object({
      provider_id: providerParam,
      bucket: bucketParam,
      aspect: Type.Optional(
        Type.Union(
          ASPECTS.map((aspect) => Type.Literal(aspect)),
          { description: 'security (default), lifecycle, observability, or access.' },
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
      const aws = deps.providers.isAws(config)
      const account =
        (aspect === 'security' || aspect === 'access') && aws
          ? await readAccount(
              deps.providers.sts(config),
              deps.providers.control(config),
              run.signal,
            )
          : UNREAD_ACCOUNT
      const facts = await readBucket(client, args.bucket, {
        aspects: new Set([aspect === 'access' ? 'security' : aspect]),
        signal: run.signal,
        regional: run.regional,
        defaultRegion: config.region,
        aws,
        account,
      })
      if (facts.head === 'missing') throw new Error(`Bucket '${args.bucket}' does not exist.`)

      if (aspect === 'access') {
        const access = await readAccess({
          bucket: args.bucket,
          facts,
          aws,
          iam: aws && config.caps.iam ? deps.providers.iam(config) : undefined,
          kms: aws && config.caps.kms ? deps.providers.kms(config, facts.region) : undefined,
          analyzer:
            aws && config.caps.accessAnalyzer
              ? deps.providers.accessAnalyzer(config, facts.region)
              : undefined,
          organizations: aws ? deps.providers.organizations(config) : undefined,
          signal: run.signal,
          session: accessSession(deps, run.conversationId),
        })
        const permissions = [
          ...permissionGaps(facts),
          ...accessPermissionGaps(args.bucket, access.blind),
        ]
        const lines = access.paths.length
          ? access.paths.map(
              (item) =>
                `${item.source}: ${item.principal} — ${item.actions.join(', ')}${
                  item.condition ? ` (${item.condition})` : ''
                }${item.note ? ` · ${item.note}` : ''}`,
            )
          : ['No policy, ACL, identity or key grant was readable for this bucket.']
        for (const item of access.blind)
          lines.push(`${item.source} could not be read (${item.status}); access is not complete.`)
        for (const gap of permissions)
          lines.push(`Missing permission: ${gap.action}${gap.bucket ? ` on ${gap.bucket}` : ''}.`)
        lines.push(
          `Coverage: ${access.coverage.evaluated}/${access.coverage.principals} principal(s) evaluated; ${access.coverage.undecided} undecided; ${access.coverage.truncated ? 'truncated' : 'not truncated'}.`,
        )
        return {
          model: lines.join('\n'),
          note: `${access.paths.length} access path${access.paths.length === 1 ? '' : 's'}${
            access.blind.length ? ` · ${access.blind.length} unread` : ''
          }${access.coverage.undecided ? ` · ${access.coverage.undecided} undecided` : ''}`,
          view: {
            kind: 'config' as const,
            bucket: args.bucket,
            providerId: config.id,
            aspect: 'access' as const,
            findings: [],
            access: access.paths,
            accessBlind: access.blind,
            accessCoverage: access.coverage,
            permissions,
            observations: [],
          },
        }
      }

      // Only the rules this aspect can see are applied; the others keep their state.
      const wanted = new Set(aspectsOf(aspect))
      const decisions = Object.fromEntries(
        Object.entries(decide(facts, deps.lang())).filter(([code]) => wanted.has(code)),
      )
      const { observations } = await run.assess.apply(config.id, args.bucket, decisions)
      const previous = (await deps.estate.postureOf(config.id, args.bucket)) ?? {}
      await deps.db.upsertBucket(
        config.id,
        args.bucket,
        { ...previous, ...pick(rememberable(facts), REMEMBERED[aspect]) },
        facts.region,
      )

      const { findings, passed } = reviewFindings(facts, aspect, deps.lang())
      const issues = (await deps.estate.issueRows(config.id, deps.lang(), 100)).filter(
        (issue) => issue.bucket === args.bucket,
      )
      const problems = findings.filter((finding) => finding.severity !== 'blind')
      const blind = findings.filter((finding) => finding.severity === 'blind')
      const lines = problems.length
        ? problems.map((f) => `[${f.severity}] ${f.title}: ${f.detail}`)
        : [`No rule in the ${aspect} review was triggered.`]
      if (blind.length)
        lines.push(`Blind (undecided, not clean): ${blind.map((f) => f.title).join('; ')}.`)
      if (passed) lines.push(`${passed} rule(s) checked and not triggered.`)
      if (aspect === 'security')
        lines.push(
          `Exposure: ${facts.exposure.verdict === null ? 'undecided' : facts.exposure.verdict ? 'public' : 'not public'}.`,
        )
      for (const gap of permissionGaps(facts))
        lines.push(`Missing permission: ${gap.action}${gap.bucket ? ` on ${gap.bucket}` : ''}.`)
      if (issues.length)
        lines.push(
          `Issues recorded for ${args.bucket}: ${issues.map((issue) => `${issue.title} (${issue.status})`).join('; ')}.`,
        )
      return {
        model: lines.join('\n'),
        note: `${problems.length} finding${problems.length === 1 ? '' : 's'}${
          blind.length ? ` · ${blind.length} unread` : ''
        }`,
        view: {
          kind: 'config' as const,
          bucket: args.bucket,
          providerId: config.id,
          aspect,
          ...(aspect === 'security'
            ? {
                exposure:
                  facts.exposure.verdict === null
                    ? ('unknown' as const)
                    : facts.exposure.verdict
                      ? ('public' as const)
                      : ('not public' as const),
              }
            : {}),
          findings,
          issues,
          observations,
          permissions: permissionGaps(facts),
        },
      }
    },
  })
}

/** The run's access session: IAM details and SCPs are read once, not per bucket. */
function accessSession(deps: ToolDeps, conversationId: string): AccessSession | undefined {
  const sessions = deps.accessSessions
  if (!sessions) return undefined
  const session = sessions.get(conversationId) ?? {}
  sessions.set(conversationId, session)
  return session
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
  access: ['region', 'publicly_exposed', 'encryption_status', 'policy_status', 'acl_status'],
}

function pick(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]))
}
