import { HeadBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3'
import type { ProbeCheck } from '@shared/contract'
import { describe } from '../providers'
import { agentTool, assertInScope, providerParam, type ToolDeps, Type } from './policy'

export function probeTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'probe',
    description:
      'Probe an S3-compatible endpoint read-only: reachability, TLS, latency, bucket region, and path-style addressing. Use it when a connection or signature fails.',
    parameters: Type.Object({
      provider_id: providerParam,
      bucket: Type.Optional(
        Type.String({ description: 'Bucket to test region and addressing against.' }),
      ),
      check: Type.Optional(
        Type.Union(
          [
            Type.Literal('reach'),
            Type.Literal('tls'),
            Type.Literal('latency'),
            Type.Literal('location'),
            Type.Literal('addressing'),
          ],
          { description: 'One check; omit to run reach, TLS and latency.' },
        ),
      ),
    }),
    timeoutMs: 60_000,
    target: (args) => args.bucket ?? 'endpoint',
    run: async (args, run) => {
      const { config, client } = await run.provider(args.provider_id)
      // A probe that names a bucket is a storage read and must obey the account
      // scope before any request leaves the process.
      if (args.bucket) assertInScope(config, args.bucket)
      const endpoint = config.endpoint || `https://s3.${config.region}.amazonaws.com`
      const checks: ProbeCheck[] = []
      const wanted = args.check ? [args.check] : (['reach', 'tls', 'latency'] as const)

      for (const check of wanted) {
        if (check === 'reach') {
          const started = Date.now()
          try {
            const response = await fetch(endpoint, {
              method: 'HEAD',
              signal: AbortSignal.any([run.signal, AbortSignal.timeout(10_000)]),
            })
            checks.push({
              name: 'Reachability',
              ok: response.status < 500,
              detail: `HTTP ${response.status} from ${endpoint}`,
              ms: Date.now() - started,
            })
          } catch (error) {
            checks.push({
              name: 'Reachability',
              ok: false,
              detail: error instanceof Error ? error.message.slice(0, 160) : 'unreachable',
              ms: Date.now() - started,
            })
          }
        } else if (check === 'tls') {
          const started = Date.now()
          const secure = endpoint.startsWith('https://')
          checks.push({
            name: 'TLS',
            ok:
              secure ||
              endpoint.startsWith('http://127.0.0.1') ||
              endpoint.startsWith('http://localhost'),
            detail: secure
              ? 'HTTPS endpoint'
              : 'Plain HTTP — credentials cross the network unencrypted',
            ms: Date.now() - started,
          })
        } else if (check === 'latency') {
          const started = Date.now()
          try {
            await client.send(new ListBucketsCommand({}), { abortSignal: run.signal })
            const ms = Date.now() - started
            checks.push({ name: 'Latency', ok: ms < 2000, detail: `ListBuckets in ${ms} ms`, ms })
          } catch (error) {
            checks.push({
              name: 'Latency',
              ok: false,
              detail: describe(error),
              ms: Date.now() - started,
            })
          }
        } else if (check === 'location') {
          const bucket = args.bucket
          if (!bucket) throw new Error('location needs a bucket.')
          const started = Date.now()
          try {
            await client.send(new HeadBucketCommand({ Bucket: bucket }), {
              abortSignal: run.signal,
            })
            checks.push({
              name: 'Bucket',
              ok: true,
              detail: `${bucket} is reachable in ${config.region}`,
              ms: Date.now() - started,
            })
          } catch (error) {
            checks.push({
              name: 'Bucket',
              ok: false,
              detail: describe(error),
              ms: Date.now() - started,
            })
          }
        } else {
          const bucket = args.bucket
          if (!bucket) throw new Error('addressing needs a bucket.')
          const started = Date.now()
          const alternate = deps.providers.client({
            ...config,
            forcePathStyle: !config.forcePathStyle,
          })
          try {
            await alternate.send(new HeadBucketCommand({ Bucket: bucket }), {
              abortSignal: run.signal,
            })
            checks.push({
              name: 'Addressing',
              ok: !config.forcePathStyle,
              detail: `HeadBucket succeeds with ${config.forcePathStyle ? 'path-style' : 'virtual-hosted'} addressing`,
              ms: Date.now() - started,
            })
          } catch (error) {
            checks.push({
              name: 'Addressing',
              ok: false,
              detail: `Configured ${config.forcePathStyle ? 'path-style' : 'virtual-hosted'} failed: ${describe(error)}`,
              ms: Date.now() - started,
            })
          }
        }
      }

      return {
        model: checks
          .map((check) => `${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}`)
          .join('\n'),
        note: checks.every((check) => check.ok) ? 'all checks passed' : 'a check failed',
        view: { kind: 'probe' as const, endpoint, checks },
      }
    },
  })
}
