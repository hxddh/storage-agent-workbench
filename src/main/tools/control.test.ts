import { describe, expect, it } from 'vitest'
import { planTool, skillTool } from './control'

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

  it('loads one method or lists the four methods', async () => {
    const one = await execute(skillTool(), { name: 'access' })
    expect(one.output?.[0]?.text).toContain('IAM principals and policies')
    const all = await execute(skillTool(), {})
    expect(all.output?.[0]?.text).toContain('Access evidence')
    expect(all.output?.[0]?.text).toContain('Capacity and cost')
  })
})
