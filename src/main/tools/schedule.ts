import { int, lit, obj, opt, str, union } from '@earendil-works/pi-schema'
import { agentTool, type ToolDeps } from './policy'

/** Work for later: a prompt that runs on its own, in its own task, within a budget. */
export function scheduleTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'schedule',
    description:
      "Schedule work for later. `create` a schedule: a name, the prompt each run starts with (write it so it stands alone: what to read, what to compare with your workspace notes, when to notify), and when — `at <ISO time>` once, or `every <n>m`, `every <n>h`, `daily HH:MM`, `weekly <day> HH:MM` in the user's local time. Each run is a turn in the schedule's own task, which the user can open. Nobody watches a run: it stops at its token budget (budget_tokens, default 100,000) and should tell the user with `notify` only when something needs them. `list` shows schedules; `cancel` removes one.",
    parameters: obj({
      action: union([lit('create'), lit('list'), lit('cancel')]),
      name: opt(str({ description: 'For create and cancel: the schedule name.' })),
      prompt: opt(str({ description: 'For create: the prompt each run starts with.' })),
      when: opt(
        str({
          description:
            'For create: at <ISO time>, every <n>m|<n>h, daily HH:MM or weekly <day> HH:MM.',
        }),
      ),
      budget_tokens: opt(
        int({
          minimum: 1000,
          description: 'For create: the most tokens one unattended run may use.',
        }),
      ),
    }),
    target: (args) => `${args.action}${args.name ? ` · ${args.name}` : ''}`,
    run: async (args, run) => {
      const schedules = deps.host?.schedules
      if (!schedules) throw new Error('Scheduling is not available here.')
      if (args.action === 'list') {
        const list = await schedules.list()
        return {
          model: list.length ? JSON.stringify(list, null, 1) : 'No schedules.',
          note: `${list.length} schedule${list.length === 1 ? '' : 's'}`,
          view: { kind: 'raw' as const, title: 'Schedules', value: list },
        }
      }
      const name = (args.name ?? '').trim()
      if (!name) throw new Error(`schedule ${args.action} needs a name.`)
      if (args.action === 'cancel') {
        const gone = await schedules.cancel(name)
        return {
          model: `Cancelled "${name}". Its task and past runs stay.`,
          view: { kind: 'raw' as const, title: `Cancelled · ${name}`, value: gone },
        }
      }
      const created = (await schedules.create({
        name,
        prompt: args.prompt ?? '',
        cadence: args.when ?? '',
        budgetTokens: args.budget_tokens ?? null,
        createdBy: run.conversationId,
      })) as { nextAt?: string | null }
      return {
        model: `Scheduled "${name}"; the first run is due ${created.nextAt ?? 'soon'}. ${JSON.stringify(created)}`,
        note: created.nextAt ? `next ${created.nextAt.slice(0, 16)}` : null,
        view: { kind: 'raw' as const, title: `Scheduled · ${name}`, value: created },
      } as never
    },
  })
}
