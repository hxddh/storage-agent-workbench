import { map, obj, str, unknown } from '@earendil-works/pi-schema'
import { CHANGE_OPERATIONS } from '../changes'
import { agentTool, providerParam, type ToolDeps } from './policy'

/** Propose one write; the user approves it in the window, and only then does the app run it. */
export function changeTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'change',
    description: `Propose one change to the account's storage for the user to approve. You never make a change: the window shows the user the exact call, what it replaces and your reason, with Approve and Reject; only their approval runs it, and the result comes back to you as their next message — then read again to verify. Before proposing, the app reads the current state so the change can be rolled back; a change whose current state cannot be read is not proposed. Only reversible bucket configuration can be changed: ${CHANGE_OPERATIONS.join(', ')}. The account must allow changes (Settings → Storage accounts); if it does not, say so or propose allow_changes with self. Propose one change at a time; your turn ends until the user decides.`,
    parameters: obj({
      provider_id: providerParam,
      service: str({ description: 's3 or s3control.' }),
      operation: str({ description: 'e.g. PutPublicAccessBlock.' }),
      input: map(unknown(), {
        description: 'The operation input as the AWS SDK names it; a Policy may be an object.',
      }),
      reason: str({
        description: 'One or two sentences for the user: what this fixes and what it could break.',
      }),
    }),
    target: (args) => {
      const bucket = (args.input as { Bucket?: unknown }).Bucket
      return `${args.service} ${args.operation}${typeof bucket === 'string' ? ` · ${bucket}` : ''}`
    },
    run: async (args, run) => {
      const changes = deps.host?.changes
      if (!changes) throw new Error('Changes are not available here.')
      const proposed = await changes.propose({
        conversationId: run.conversationId,
        providerId: args.provider_id,
        service: args.service,
        operation: args.operation,
        input: args.input as Record<string, unknown>,
        reason: args.reason,
      })
      return {
        model: `Proposed change ${proposed.changeId}: ${proposed.title}. It replaces: ${JSON.stringify(proposed.before)}. The user decides in the window; your turn ends here.`,
        note: 'waiting for the user',
        view: { kind: 'change' as const, ...proposed },
        terminate: true,
      }
    },
  })
}
