import { int, map, obj, opt, str, unknown } from '@earendil-works/pi-schema'
import { callApi, SERVICES } from '../s3/api'
import { agentTool, providerParam, type ToolDeps } from './policy'

/** Any read-only operation of a service the app bundles, as the service answers it. */
export function callTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'call',
    description: `Call one read-only operation of the account's storage or an AWS service the app bundles (${SERVICES.join(', ')}), with the operation's own input as the AWS SDK names it, and get the service's response as JSON. Any operation named Get, List, Head, Describe, Lookup, Search, Select, Simulate or BatchGet runs, except the few that hand out credentials; nothing else does. Examples: s3 ListBuckets, s3 ListObjectsV2 {Bucket, Prefix, ContinuationToken}, s3 GetBucketPolicy {Bucket}, s3 GetObject {Bucket, Key, Range}, s3control GetPublicAccessBlock, iam GetAccountAuthorizationDetails, organizations ListPoliciesForTarget, cloudwatch GetMetricData, cloudtrail LookupEvents. Every identifier comes back as the service returned it: account ids, access key ids, ARNs, names. \`<account>\` in an input stands for the calling account's id; S3 Control's AccountId is filled in when left out. A custom-endpoint account answers every service at its own endpoint. A body (GetObject) streams to the task folder; the result carries a preview and a token \`more\` can read at any offset. A body read stops at max_bytes (default 1 MiB, yours to raise); a Range reads any part of an object. A failed call returns the service's error code, HTTP status and message.`,
    parameters: obj({
      provider_id: providerParam,
      service: str({ description: `One of ${SERVICES.join(', ')}.` }),
      operation: str({ description: 'The operation, e.g. GetBucketPolicy.' }),
      input: opt(
        map(unknown(), {
          description: 'The operation input, as the AWS SDK names its fields.',
        }),
      ),
      region: opt(str({ description: "The region to call; default the account's." })),
      max_bytes: opt(
        int({
          minimum: 0,
          description: 'For a body or event stream: read at most this many bytes (default 1 MiB).',
        }),
      ),
    }),
    target: (args) => {
      const bucket = (args.input as { Bucket?: unknown } | undefined)?.Bucket
      return `${args.service} ${args.operation}${typeof bucket === 'string' ? ` · ${bucket}` : ''}`
    },
    run: async (args, run) => {
      const { config } = await run.provider(args.provider_id)
      const value = await callApi(
        {
          providers: deps.providers,
          config,
          signal: run.signal,
          bodyDir: deps.taskDir(run.conversationId),
        },
        {
          service: args.service,
          operation: args.operation,
          input: args.input,
          region: args.region,
          maxBytes: args.max_bytes,
        },
      )
      return {
        model: JSON.stringify(value, null, 1),
        view: { kind: 'raw' as const, title: `${args.service} ${args.operation}`, value },
      }
    },
  })
}
