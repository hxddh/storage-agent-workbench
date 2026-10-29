import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentTool, PIECE, resultPath, type ToolDeps, Type } from './policy'

/** The rest of a result the model got only the first piece of. */
export function moreTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'more',
    description: `Read further into a result that was longer than one piece (${PIECE.toLocaleString('en-US')} characters) or an object body: give its evidence id and the offset where to continue.`,
    parameters: Type.Object({
      evidence: Type.String({ description: 'The evidence id of the cut result.' }),
      offset: Type.Integer({
        minimum: 0,
        description: 'Offset to read from: characters for a kept result, bytes for an object body.',
      }),
    }),
    target: (args) => `${args.evidence} @ ${args.offset}`,
    run: async (args, run) => {
      const object = /^objects\/[A-Za-z0-9._-]+$/.test(args.evidence)
      const path = object
        ? join(deps.taskDir(run.conversationId), args.evidence)
        : resultPath(deps, run.conversationId, args.evidence)
      let text: string
      let total: number
      let end: number
      let unit: 'characters' | 'bytes'
      try {
        if (object) {
          // An object body is read at a byte offset; it never enters memory whole.
          const handle = await open(path, 'r')
          try {
            const size = (await handle.stat()).size
            const start = Math.min(args.offset, size)
            const length = Math.min(PIECE, size - start)
            const buffer = Buffer.alloc(length)
            await handle.read(buffer, 0, length, start)
            text = buffer.toString('utf8')
            total = size
            end = start + length
            unit = 'bytes'
          } finally {
            await handle.close()
          }
        } else {
          const kept = await readFile(path, 'utf8')
          text = kept.slice(args.offset, args.offset + PIECE)
          total = kept.length
          end = args.offset + text.length
          unit = 'characters'
        }
      } catch {
        throw new Error(`No kept result or object for evidence "${args.evidence}" in this task.`)
      }
      const rest = total - end
      return {
        model: `${text}${rest > 0 ? `\n… ${rest} more ${unit} (offset ${end}).` : '\n(end of result)'}`,
        note: `${args.offset.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${unit}`,
        view: {
          kind: 'note' as const,
          text: `${unit === 'bytes' ? 'Bytes' : 'Characters'} ${args.offset}–${end} of ${total}.`,
        },
      }
    },
  })
}
