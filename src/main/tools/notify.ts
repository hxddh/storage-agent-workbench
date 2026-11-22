import { obj, str } from '@earendil-works/pi-schema'
import { agentTool, type ToolDeps } from './policy'

/** Reach the user now: a system notification and an entry in the window's inbox. */
export function notifyTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'notify',
    description:
      "Tell the user something now, when they may not be looking: a system notification and an entry in the window's inbox that opens this task. Use it when a scheduled run finds something they need to know or act on; do not notify that nothing changed. One notification per run: put everything in it. The user's notification setting can turn it off; then it says so.",
    parameters: obj({
      title: str({
        minLength: 1,
        description: 'A short headline, e.g. "web-assets became public".',
      }),
      body: str({ description: 'One or two sentences: what changed and what to do.' }),
    }),
    target: (args) => args.title,
    run: async (args, run) => {
      const host = deps.host
      if (!host) throw new Error('Notifications are not available here.')
      const result = await host.notify(
        run.conversationId,
        args.title.slice(0, 120),
        args.body.slice(0, 600),
      )
      if (!result.shown && !result.stored)
        throw new Error(result.reason ?? 'The notification was not shown.')
      return {
        model: result.shown ? 'The user was notified.' : (result.reason ?? 'It is in the inbox.'),
        view: { kind: 'note' as const, text: `${args.title} — ${args.body}` },
      }
    },
  })
}
