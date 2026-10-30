import { checkViewDoc, viewText } from '@shared/view'
import { agentTool, type ToolDeps, Type } from './policy'

/**
 * The agent's presentation primitive. The document is data; the window owns
 * the renderer. A view may contain Markdown, tables, charts, timelines, trees,
 * diffs and callouts, nested in any order.
 */
export function renderTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'render',
    description:
      'Compose a view from a declarative block tree. Use it when a table, chart, timeline, tree or diff says more than prose. It is optional: normal Markdown is always valid. The document is data, never HTML or code.',
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: 'A short name for the view.' })),
      doc: Type.Unknown({
        description:
          'A ViewDoc: {version:1, blocks:[...]}. Blocks: markdown, section, stack, row, table, chart, code, callout, kv, tree, diff, timeline, link.',
      }),
    }),
    target: (args) => args.title ?? 'view',
    run: async (args) => {
      const { doc, errors } = checkViewDoc(args.doc)
      if (!doc) throw new Error(`The view was not drawn: ${errors.join('; ')}.`)
      return {
        // What was drawn, and what of the view was not and why, so the agent can correct it.
        model: `${viewText(doc)}${errors.length ? `\n\nNot drawn as given: ${errors.join('; ')}.` : ''}`,
        note: `${doc.blocks.length} block${doc.blocks.length === 1 ? '' : 's'}`,
        view: { kind: 'render' as const, title: args.title ?? 'View', doc },
      }
    },
  })
}
