import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { skillIndex } from './runtime/agent'
import { parseSkill, Skills } from './skills'
import type { ToolDeps } from './tools/policy'
import { skillTool } from './tools/skill'

const temp = () => mkdtempSync(join(tmpdir(), 'skills-'))

describe('skills', () => {
  it('ships bundled skills with a name and a description each', () => {
    const skills = new Skills(temp()).list()
    const names = skills.map((skill) => skill.name)
    expect(names).toEqual(
      expect.arrayContaining(['public-access', 'cross-account', 'encryption', 'change-history']),
    )
    for (const skill of skills) {
      expect(skill.source).toBe('bundled')
      expect(skill.description.length).toBeGreaterThan(20)
      expect(skill.body.length).toBeGreaterThan(200)
    }
  })

  it('lets a user file replace a bundled skill and add new ones', () => {
    const dir = temp()
    writeFileSync(
      join(dir, 'public-access.md'),
      '---\nname: public-access\ndescription: Our own way\n---\nUse the org checklist.',
    )
    writeFileSync(join(dir, 'notes.md'), 'Partner buckets live in eu-west-1.')
    const skills = new Skills(dir)
    expect(skills.get('public-access')).toMatchObject({
      source: 'user',
      body: 'Use the org checklist.',
    })
    expect(skills.get('notes')).toMatchObject({
      description: 'Partner buckets live in eu-west-1.',
      source: 'user',
    })
  })

  it('saves, reads and deletes a skill through the tool, and never deletes a bundled one', async () => {
    const dir = temp()
    const deps = {
      skills: new Skills(dir),
      db: { rootConversation: async (id: string) => id, audit: async () => undefined },
      taskDir: () => temp(),
    } as unknown as ToolDeps
    const tool = skillTool(deps)
    const exec = async (args: Record<string, unknown>) => {
      const result = (await tool.execute(
        args as never,
        {
          conversationId: 'c1',
          callId: 'k',
          details: async () => undefined,
          output: () => undefined,
        } as never,
        {} as never,
      )) as { output: { text: string }[]; isError?: boolean }
      return { text: result.output.map((part) => part.text).join(''), error: result.isError }
    }
    const saved = await exec({
      action: 'save',
      name: 'vendor-buckets',
      description: 'Which buckets the vendor reads',
      body: 'Vendor account 999988887777 reads `exports/`.',
    })
    expect(saved.error).toBeFalsy()
    expect(readFileSync(join(dir, 'vendor-buckets.md'), 'utf8')).toContain('999988887777')
    expect((await exec({ action: 'read', name: 'vendor-buckets' })).text).toContain('exports/')
    expect((await exec({ action: 'delete', name: 'public-access' })).error).toBe(true)
    expect((await exec({ action: 'delete', name: 'vendor-buckets' })).error).toBeFalsy()
    expect(deps.skills?.get('vendor-buckets')).toBeNull()
  })

  it('lists every skill in the prompt by name and description only', () => {
    const index = skillIndex({ skills: new Skills(temp()) } as unknown as ToolDeps)
    expect(index).toMatch(/- public-access: /)
    expect(index).not.toMatch(/## The layers/)
  })

  it('names a file without front matter by its file name', () => {
    expect(parseSkill('# Title\nbody', 'x')).toMatchObject({ name: 'x', description: '# Title' })
  })
})
