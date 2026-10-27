import type { ReportBlock } from '@shared/contract'
import { describe, expect, it } from 'vitest'
import { answerTool, planTool, skillTool } from './control'

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

  it('records prose with at most two evidence ids', async () => {
    const result = await execute(answerTool(), {
      title: 'Answer',
      text: 'Only `demo` is public.',
      show: ['ev-1', 'ev-2', 'ev-3'],
    })
    const view = result.details?.view as {
      kind: string
      text?: string
      show?: string[]
      blocks: ReportBlock[]
    }
    expect(view.kind).toBe('report')
    expect(view.text).toBe('Only `demo` is public.')
    expect(view.show).toEqual(['ev-1', 'ev-2'])
    expect(view.blocks).toEqual([])
  })

  it('rejects an empty answer', async () => {
    const result = await execute(answerTool(), { text: '   ' })
    expect(result.isError).toBe(true)
    expect(result.details?.status).toBe('failed')
  })

  it('loads one method or lists the four methods', async () => {
    const one = await execute(skillTool(), { name: 'access' })
    expect(one.output?.[0]?.text).toContain('IAM principals and policies')
    const all = await execute(skillTool(), {})
    expect(all.output?.[0]?.text).toContain('Access evidence')
    expect(all.output?.[0]?.text).toContain('Capacity and cost')
  })
})
