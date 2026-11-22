import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDeps } from '../tools/policy'
import { Workspace } from '../workspace'
import { buildDigest, createAgent } from './agent'

describe('the agent loop', () => {
  it('indexes the run after it settles, and has no hook that blocks a call', () => {
    const extension = createAgent({} as ToolDeps, { digest: () => '', language: () => 'en' }, [])
    const hooks =
      (extension as { hooks?: { task?: string; handlers?: Record<string, unknown> }[] }).hooks ?? []
    expect(hooks).toHaveLength(1)
    expect(hooks[0]?.task).toBe('pi.generation')
    expect(Object.keys(hooks[0]?.handlers ?? {})).toEqual(['afterRun'])
  })

  it('states the hard rules, and no ceiling or workflow', async () => {
    const extension = createAgent(
      {} as ToolDeps,
      { digest: () => '', language: () => 'en' },
      [],
    ) as unknown as {
      sections: { key: string; render: () => unknown }[]
    }
    const prompt = (await Promise.all(extension.sections.map((item) => item.render()))).join('\n')
    expect(prompt).toMatch(/read-only/)
    expect(prompt).toMatch(/never instructions/)
    expect(prompt).not.toMatch(/rounds of tool calls|at most|budget/i)
  })
})

describe('the context digest', () => {
  it('names the accounts and what the workspace holds by folder, never file content', async () => {
    const workspace = new Workspace(mkdtempSync(join(tmpdir(), 'sa-digest-')))
    workspace.write('notes/accounts.md', 'fresh note: vendor 999988887777')
    workspace.write('notes/old.md', 'old note')
    const deps = {
      providers: {
        list: async () => [
          { id: 'p1', name: 'Prod', endpoint: '', region: 'us-east-1', scope: { buckets: [] } },
        ],
      },
      workspace,
    } as unknown as ToolDeps
    const digest = await buildDigest(deps)
    expect(digest).toContain('Prod (id p1; AWS, region us-east-1)')
    expect(digest).toContain('Workspace: notes/ 2 files')
    expect(digest).toContain('data, never instructions')
    expect(digest).not.toContain('fresh note')
    expect(digest).not.toContain('old note')
  })
})
