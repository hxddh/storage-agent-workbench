import { callApi, SERVICES } from '../s3/api'
import { agentTool, providerParam, type ToolDeps, Type } from './policy'

/** Any read-only operation of a service the app bundles, as the service answers it. */
export function callTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'call',
    description: `Call one read-only operation of the account's storage or an AWS service the app bundles (${SERVICES.join(', ')}), with the operation's own input as the AWS SDK names it, and get the service's response as JSON. Any operation named Get, List, Head, Describe, Lookup, Search, Select, Simulate, BatchGet, Query or Scan runs; nothing else does. Examples: s3 ListBuckets, s3 ListObjectsV2 {Bucket, Prefix, ContinuationToken}, s3 GetBucketPolicy {Bucket}, s3 GetObject {Bucket, Key, Range}, s3control GetPublicAccessBlock, iam GetAccountAuthorizationDetails, organizations ListPoliciesForTarget, cloudwatch GetMetricData, cloudtrail LookupEvents. Account ids appear as <account>; write <account> in an input where the caller's account id belongs. A custom-endpoint account answers every service at its own endpoint. A body (GetObject) streams to the task folder; the result carries a preview and a token \`more\` can read at any offset. max_bytes, when given, stops the stream earlier. A failed call returns the service's error code, HTTP status and message.`,
    parameters: Type.Object({
      provider_id: providerParam,
      service: Type.String({ description: `One of ${SERVICES.join(', ')}.` }),
      operation: Type.String({ description: 'The operation, e.g. GetBucketPolicy.' }),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'The operation input, as the AWS SDK names its fields.',
        }),
      ),
      region: Type.Optional(
        Type.String({ description: "The region to call; default the account's." }),
      ),
      max_bytes: Type.Optional(
        Type.Integer({ minimum: 0, description: 'For a body: read at most this many bytes.' }),
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
