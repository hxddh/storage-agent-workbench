import { describe, expect, it } from 'vitest'
import { askTool } from './control'

type Executable = {
  execute: (
    args: never,
    api: never,
    context: never,
  ) => Promise<{
    details?: { view?: unknown; status?: string }
    isError?: boolean
    output?: { text?: string }[]
    control?: { terminate?: boolean }
  }>
}

function execute(tool: unknown, args: unknown) {
  return (tool as Executable).execute(args as never, {} as never, {} as never)
}

describe('ask', () => {
  it('asks a question, with or without options, and ends the turn', async () => {
    const result = await execute(askTool(), {
      question: '  Which account should I read?  ',
      options: [' Demo ', ' Production ', ''],
      note: 'Scope changes the answer.',
    })
    const view = result.details?.view as {
      kind: string
      question: string
      options: string[]
    }
    expect(view.kind).toBe('question')
    expect(view.question).toBe('Which account should I read?')
    expect(view.options).toEqual(['Demo', 'Production'])
    expect(result.control).toEqual({ terminate: true })
    const open = await execute(askTool(), { question: 'What should I focus on?' })
    expect(open.details?.view).toMatchObject({ kind: 'question', options: [] })
  })
})
