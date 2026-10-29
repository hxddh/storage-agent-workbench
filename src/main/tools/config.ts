import { readConfig, SECTIONS, type Section } from '../s3/raw'
import { agentTool, assertInScope, bucketParam, providerParam, type ToolDeps, Type } from './policy'

export function configTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'config',
    description: `Read one bucket's configuration as S3 returns it, section by section: ${SECTIONS.join(', ')}. Each section is { status, value } or { status, error }; status is available, not_configured, access_denied, provider_unsupported, missing, region_mismatch or error. The bucket policy comes back parsed. Omit sections to read all of them.`,
    parameters: Type.Object({
      provider_id: providerParam,
      bucket: bucketParam,
      sections: Type.Optional(
        Type.Array(Type.Union(SECTIONS.map((section) => Type.Literal(section)))),
      ),
    }),
    timeoutMs: 90_000,
    target: (args) => args.bucket,
    run: async (args, run) => {
      const { config, client } = await run.provider(args.provider_id)
      assertInScope(config, args.bucket)
      const sections = (args.sections?.length ? args.sections : SECTIONS) as Section[]
      const read = await readConfig(client, args.bucket, sections, {
        signal: run.signal,
        regional: run.regional,
        defaultRegion: config.region || 'us-east-1',
      })
      const counts = Object.values(read.sections).reduce<Record<string, number>>((sum, item) => {
        if (item) sum[item.status] = (sum[item.status] ?? 0) + 1
        return sum
      }, {})
      return {
        model: JSON.stringify(
          { bucket: args.bucket, region: read.region, ...read.sections },
          null,
          1,
        ),
        note: Object.entries(counts)
          .map(([status, n]) => `${n} ${status.replace(/_/g, ' ')}`)
          .join(' · '),
        view: {
          kind: 'raw' as const,
          title: args.bucket,
          value: { region: read.region, ...read.sections },
        },
      }
    },
  })
}
