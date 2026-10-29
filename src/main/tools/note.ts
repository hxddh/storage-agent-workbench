import { redact } from '../security/redact'
import { agentTool, providerParam, type ToolDeps, Type } from './policy'

/** The agent's own memory: notes it writes, shown to it at the start of every turn. */
export function noteTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'note',
    description:
      'Remember a fact about the storage, an account or a bucket. Notes are shown to you at the start of every turn; the user can forget them in Settings.',
    parameters: Type.Object({
      text: Type.String({ description: 'The note.' }),
      scope: Type.Optional(
        Type.Union([Type.Literal('estate'), Type.Literal('provider'), Type.Literal('bucket')], {
          description: 'Where the note belongs; default estate (everything).',
        }),
      ),
      bucket: Type.Optional(Type.String({ description: 'Bucket name when scope is bucket.' })),
      provider_id: providerParam,
    }),
    timeoutMs: 10_000,
    target: () => 'note',
    run: async (args) => {
      const text = redact(args.text).trim()
      if (!text) throw new Error('The note is empty.')
      const scope = args.scope ?? 'estate'
      let ref: string | null = null
      if (scope !== 'estate') {
        const config = await deps.providers.resolve(args.provider_id)
        ref = scope === 'bucket' ? `${config.id}/${args.bucket ?? ''}` : config.id
        if (scope === 'bucket' && !args.bucket)
          throw new Error('A bucket note needs a bucket name.')
      }
      const note = await deps.db.insertNote({ scope, ref, text, author: 'agent' })
      return {
        model: `Remembered (${scope}): ${text}`,
        note: 'saved',
        view: { kind: 'note' as const, text: note.text },
      }
    },
  })
}
