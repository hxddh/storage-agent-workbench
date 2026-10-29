import { redact } from '../security/redact'
import { agentTool, type ToolDeps, Type } from './policy'

/** The agent's own memory: notes it writes, shown to it at the start of every turn. */
export function noteTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'note',
    description:
      'Remember something for later tasks, or forget a note that no longer holds. Every note is shown to you, with its id, at the start of every turn; the user can forget any of them in Settings.',
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: 'The note to remember.' })),
      forget: Type.Optional(Type.String({ description: 'The id of a note to forget.' })),
    }),
    target: () => 'note',
    run: async (args) => {
      if (args.forget) {
        const note = (await deps.db.listNotes()).find((item) => item.id === args.forget)
        if (!note) throw new Error(`No note with id ${args.forget}.`)
        await deps.db.deleteNote(note.id)
        return {
          model: `Forgot: ${note.text}`,
          note: 'forgotten',
          view: { kind: 'note' as const, text: note.text },
        }
      }
      const text = redact(args.text ?? '').trim()
      if (!text) throw new Error('The note is empty.')
      const note = await deps.db.insertNote({ text })
      return {
        model: `Remembered: ${text}`,
        note: 'saved',
        view: { kind: 'note' as const, text: note.text },
      }
    },
  })
}
