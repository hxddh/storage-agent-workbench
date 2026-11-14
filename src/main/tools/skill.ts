import { lit, obj, opt, str, union } from '@earendil-works/pi-schema'
import type { ViewDoc } from '@shared/contract'
import { agentTool, type ToolDeps } from './policy'

/** Read, write and forget skills: Markdown advice the agent loads when a question needs it. */
export function skillTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'skill',
    description:
      "Skills are Markdown notes on how to work a kind of storage question: which reads settle it, where the traps are, what a good answer covers. Their names and descriptions are listed in your prompt. `read` one before you work on a question it covers; it is advice, and what the reads return decides. `save` a skill when you worked out something reusable (a user's skill with a bundled skill's name replaces it); `delete` removes a user skill. Skills are plain files the user can edit.",
    parameters: obj({
      action: union([lit('list'), lit('read'), lit('save'), lit('delete')]),
      name: opt(str({ description: 'The skill name: a-z, 0-9 and -.' })),
      description: opt(str({ description: 'For save: one line saying when to read it.' })),
      body: opt(str({ description: 'For save: the Markdown body.' })),
    }),
    target: (args) => `${args.action}${args.name ? ` · ${args.name}` : ''}`,
    run: async (args) => {
      const skills = deps.skills
      if (!skills) throw new Error('No skills are available in this build.')
      if (args.action === 'list') {
        const list = skills
          .list()
          .map(({ name, description, source }) => ({ name, description, source }))
        return {
          model: JSON.stringify(list, null, 1),
          note: `${list.length} skill${list.length === 1 ? '' : 's'}`,
          view: { kind: 'raw' as const, title: 'Skills', value: list },
        }
      }
      const name = args.name?.trim() ?? ''
      if (!name) throw new Error(`skill ${args.action} needs a name.`)
      if (args.action === 'read') {
        const skill = skills.get(name)
        if (!skill)
          throw new Error(
            `No skill named '${name}'. Skills: ${skills
              .list()
              .map((item) => item.name)
              .join(', ')}.`,
          )
        return {
          model: `# ${skill.name} (${skill.source})\n${skill.description}\n\n${skill.body}`,
          note: skill.source,
          view: { kind: 'render' as const, title: skill.name, doc: markdownDoc(skill.body) },
        }
      }
      if (args.action === 'save') {
        const saved = skills.save({
          name,
          description: args.description ?? '',
          body: args.body ?? '',
        })
        return {
          model: `Saved skill '${saved.name}' in ${skills.dir}.`,
          note: 'saved',
          view: { kind: 'render' as const, title: saved.name, doc: markdownDoc(saved.body) },
        }
      }
      const outcome = skills.delete(name)
      if (outcome === 'bundled')
        throw new Error(
          `'${name}' ships with the app and cannot be deleted; save a skill with the same name to replace it.`,
        )
      if (outcome === 'missing') throw new Error(`No skill named '${name}'.`)
      return {
        model: `Deleted skill '${name}'.`,
        note: 'deleted',
        view: { kind: 'note' as const, text: `Deleted ${name}` },
      }
    },
  })
}

function markdownDoc(text: string): ViewDoc {
  return { version: 1, blocks: [{ type: 'markdown', text }] }
}
