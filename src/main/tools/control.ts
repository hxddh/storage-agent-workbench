import { defineTool } from '@earendil-works/pi-durable'
import { arr, obj, opt, str } from '@earendil-works/pi-schema'
import type { ToolDetails } from '@shared/contract'

function details(view: ToolDetails['view'], target: string, note: string | null): ToolDetails {
  return { target, note, view, ms: 0, status: 'done' }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function askTool() {
  return defineTool({
    name: 'ask',
    description:
      'Ask the user a question and end your turn until they answer. Options, when given, are shown as buttons; the user can also reply in their own words.',
    parameters: obj({
      question: str({ minLength: 1 }),
      options: opt(arr(str())),
      note: opt(str()),
    }),
    execute: async (args) => {
      const question = text(args.question)
      const options = ((args.options as unknown[] | undefined) ?? [])
        .map((option) => text(option))
        .filter(Boolean)
      const note = text(args.note) || undefined
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
