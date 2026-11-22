import { arr, bool, lit, obj, opt, str, union } from '@earendil-works/pi-schema'
import { agentTool, type ToolDeps } from './policy'

/** What the agent is and may do, and the settings it may change itself. */
export function selfTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'self',
    description:
      "Know yourself and act on your own task. `read`: the model you run on (and its context window), what this task has spent, the storage accounts (name, id, endpoint, region, how it signs in, scope, whether changes are allowed — never a key), your schedules, the app version, your workspace's path, today's date, and the services you can call. `title`: rename this task. `pin`: pin or unpin it in the user's list. `propose`: ask the user to change an account's scope or to allow approved changes on it; it applies only when they approve, and your turn ends until they decide.",
    parameters: obj({
      action: union([lit('read'), lit('title'), lit('pin'), lit('propose')]),
      title: opt(str({ description: 'For title: the new task title.' })),
      pinned: opt(bool({ description: 'For pin: true to pin, false to unpin.' })),
      provider_id: opt(str({ description: 'For propose: the account.' })),
      allow_changes: opt(
        bool({ description: 'For propose: allow or stop approved changes on the account.' }),
      ),
      scope: opt(
        arr(str(), {
          description: "For propose: the account's bucket list (empty for every bucket).",
        }),
      ),
      reason: opt(str({ description: 'For propose: why, for the user.' })),
    }),
    target: (args) => args.action,
    run: async (args, run) => {
      const host = deps.host
      if (!host) throw new Error('self is not available here.')
      if (args.action === 'title') {
        const title = (args.title ?? '').trim()
        if (!title) throw new Error('self title needs a title.')
        await host.rename(run.conversationId, title.slice(0, 120))
        return {
          model: `Renamed this task to "${title.slice(0, 120)}".`,
          view: { kind: 'note' as const, text: title.slice(0, 120) },
        }
      }
      if (args.action === 'propose') {
        if (args.allow_changes === undefined && args.scope === undefined)
          throw new Error('self propose needs allow_changes or scope.')
        const proposed = await host.changes.proposeSetting({
          conversationId: run.conversationId,
          providerId: args.provider_id,
          ...(args.allow_changes !== undefined ? { allowChanges: args.allow_changes } : {}),
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          reason: args.reason ?? '',
        })
        return {
          model: `Proposed: ${proposed.title}. The user decides in the window; your turn ends here.`,
          note: 'waiting for the user',
          view: { kind: 'change' as const, ...proposed },
          terminate: true,
        }
      }
      if (args.action === 'pin') {
        const pinned = args.pinned !== false
        await host.pin(run.conversationId, pinned)
        return {
          model: pinned ? 'Pinned this task.' : 'Unpinned this task.',
          view: { kind: 'note' as const, text: pinned ? 'Pinned' : 'Unpinned' },
        }
      }
      const value = await host.self(run.conversationId)
      return {
        model: JSON.stringify(value, null, 1),
        view: { kind: 'raw' as const, title: 'Self', value },
      }
    },
  })
}
