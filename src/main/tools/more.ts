import { readFile } from 'node:fs/promises'
import { agentTool, PIECE, resultPath, type ToolDeps, Type } from './policy'

/** The rest of a result the model got only the first piece of. */
export function moreTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'more',
    description: `Read further into a result that was longer than one piece (${PIECE.toLocaleString('en-US')} characters): give its evidence id and the offset where to continue.`,
    parameters: Type.Object({
      evidence: Type.String({ description: 'The evidence id of the cut result.' }),
      offset: Type.Integer({ minimum: 0, description: 'Character offset to read from.' }),
    }),
    target: (args) => `${args.evidence} @ ${args.offset}`,
    run: async (args, run) => {
      let text: string
      try {
        text = await readFile(resultPath(deps, run.conversationId, args.evidence), 'utf8')
      } catch {
        throw new Error(`No kept result for evidence "${args.evidence}" in this task.`)
      }
      const piece = text.slice(args.offset, args.offset + PIECE)
      const end = args.offset + piece.length
      const rest = text.length - end
      return {
        model: `${piece}${rest > 0 ? `\n… ${rest} more characters (offset ${end}).` : '\n(end of result)'}`,
        note: `${args.offset.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')}`,
        view: {
          kind: 'note' as const,
          text: `Characters ${args.offset}–${end} of ${text.length}.`,
        },
      }
    },
  })
}
