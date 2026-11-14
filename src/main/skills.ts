/**
 * Skills: what people know about storage, written down as Markdown the agent
 * reads when a question needs it.
 *
 * A skill is advice, not a rule: the app never runs one, checks one or turns
 * one into a finding. The agent sees each skill's name and one-line
 * description every turn, reads the whole skill when it decides to, and
 * writes new ones from what it learned. Bundled skills ship with the app; the
 * user's own live as plain files in `<data>/skills/`, editable in any editor,
 * and a user skill with a bundled skill's name takes its place.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Skill {
  name: string
  description: string
  body: string
  source: 'bundled' | 'user'
}

const NAME = /^[a-z][a-z0-9-]{1,48}$/

const BUNDLED: Record<string, string> = import.meta.glob('./skills/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** `---\nname: …\ndescription: …\n---\nbody`; a file without front matter is named by its file. */
export function parseSkill(text: string, fallbackName: string): Omit<Skill, 'source'> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const fields: Record<string, string> = {}
  if (match)
    for (const line of (match[1] ?? '').split(/\r?\n/)) {
      const field = /^(\w+):\s*(.*)$/.exec(line)
      if (field) fields[field[1]!.toLowerCase()] = field[2]!.trim()
    }
  const body = (match ? match[2] : text)?.trim() ?? ''
  return {
    name: fields.name || fallbackName,
    description: fields.description || body.split('\n').find((line) => line.trim()) || '',
    body,
  }
}

export function formatSkill(skill: Pick<Skill, 'name' | 'description' | 'body'>): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description.replace(/\s+/g, ' ').trim()}\n---\n\n${skill.body.trim()}\n`
}

export class Skills {
  constructor(readonly dir: string) {}

  private bundled(): Skill[] {
    return Object.entries(BUNDLED).map(([path, text]) => ({
      ...parseSkill(text, path.replace(/^.*\//, '').replace(/\.md$/, '')),
      source: 'bundled' as const,
    }))
  }

  private user(): Skill[] {
    let files: string[] = []
    try {
      files = readdirSync(this.dir).filter((file) => file.endsWith('.md'))
    } catch {
      return []
    }
    const out: Skill[] = []
    for (const file of files) {
      try {
        const parsed = parseSkill(readFileSync(join(this.dir, file), 'utf8'), file.slice(0, -3))
        out.push({ ...parsed, source: 'user' })
      } catch {
        // An unreadable file is not a skill.
      }
    }
    return out
  }

  /** Every skill, the user's taking the place of a bundled one with the same name. */
  list(): Skill[] {
    const byName = new Map<string, Skill>()
    for (const skill of [...this.bundled(), ...this.user()]) byName.set(skill.name, skill)
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): Skill | null {
    return this.list().find((skill) => skill.name === name) ?? null
  }

  save(input: { name: string; description: string; body: string }): Skill {
    const name = input.name.trim()
    if (!NAME.test(name))
      throw new Error(
        'A skill name starts with a letter and uses a-z, 0-9 and - (2–49 characters).',
      )
    const description = input.description.trim()
    if (!description) throw new Error('A skill needs a one-line description of when to read it.')
    if (!input.body.trim()) throw new Error('A skill needs a body.')
    mkdirSync(this.dir, { recursive: true })
    const skill = { name, description, body: input.body }
    writeFileSync(join(this.dir, `${name}.md`), formatSkill(skill), 'utf8')
    return { ...skill, body: skill.body.trim(), source: 'user' }
  }

  delete(name: string): 'deleted' | 'bundled' | 'missing' {
    const own = this.user().find((skill) => skill.name === name)
    if (own) {
      for (const file of readdirSync(this.dir).filter((item) => item.endsWith('.md')))
        if (parseSkill(readFileSync(join(this.dir, file), 'utf8'), file.slice(0, -3)).name === name)
          rmSync(join(this.dir, file), { force: true })
      return 'deleted'
    }
    return this.bundled().some((skill) => skill.name === name) ? 'bundled' : 'missing'
  }
}
