import { describe, expect, it } from 'vitest'
import { planTool, playbookTool, reportTool } from './control'

type Executable = {
  execute: (
    args: never,
    api: never,
    context: never,
  ) => Promise<{
    details?: { view?: unknown; status?: string }
    isError?: boolean
    output?: { text?: string }[]
  }>
}

function execute(tool: unknown, args: unknown) {
  return (tool as Executable).execute(args as never, {} as never, {} as never)
}

describe('agent control tools', () => {
  it('sanitizes a plan and keeps its order', async () => {
    const result = await execute(planTool(), {
      steps: [
        { title: ' Read the account ', status: 'done' },
        { title: 'Compose', status: 'made-up' },
        { title: '   ' },
      ],
    })
    const view = result.details?.view as {
      kind: string
      steps: { title: string; status: string }[]
    }
    expect(view.kind).toBe('plan')
    expect(view.steps).toEqual([
      { title: 'Read the account', status: 'done' },
      { title: 'Compose', status: 'pending' },
    ])
  })

  it('keeps only report blocks with the fields they need', async () => {
    const result = await execute(reportTool(), {
      blocks: [
        { kind: 'summary', text: 'Only `demo` is public.', evidence: ['ev-1'] },
        { kind: 'table', evidence: [] },
        { kind: 'findings', bucket: 'demo', limit: 50 },
        { kind: 'timeline', evidence: ['ev-2'] },
      ],
    })
    const view = result.details?.view as { kind: string; blocks: { kind: string }[] }
    expect(view.kind).toBe('report')
    expect(view.blocks.map((block) => block.kind)).toEqual(['summary', 'findings', 'timeline'])
  })

  it('rejects a report with no valid block', async () => {
    const result = await execute(reportTool(), { blocks: [{ kind: 'table', evidence: [] }] })
    expect(result.isError).toBe(true)
    expect(result.details?.status).toBe('failed')
  })

  it('returns one playbook card or lists the cards', async () => {
    const one = await execute(playbookTool(), { card: 'access' })
    expect(one.output?.[0]?.text).toContain('GetAccountAuthorizationDetails')
    const all = await execute(playbookTool(), {})
    expect(all.output?.[0]?.text).toContain('## capacity')
  })
})
