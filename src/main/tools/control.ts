import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { ToolDetails } from '@shared/contract'

function details(view: ToolDetails['view'], target: string, note: string | null): ToolDetails {
  return { target, note, view, ms: 0, status: 'done' }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function askTool() {
  return defineTool({
    name: 'ask',
    description:
      'Ask the user a question and end your turn until they answer. Options, when given, are shown as buttons; the user can also reply in their own words.',
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 300 }),
      options: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 6 })),
      note: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    execute: async (args) => {
      const question = text(args.question, 300)
      const options = ((args.options as unknown[] | undefined) ?? [])
        .map((option) => text(option, 100))
        .filter(Boolean)
        .slice(0, 6)
      const note = text(args.note, 200) || undefined
      return {
        output: [
          {
            type: 'text' as const,
            text: 'Question asked. Your turn ends until the user answers.',
          },
        ],
        details: details(
          { kind: 'question', question, options, ...(note ? { note } : {}) },
          'clarify',
          question,
        ) as never,
        control: { terminate: true },
      }
    },
  })
}
