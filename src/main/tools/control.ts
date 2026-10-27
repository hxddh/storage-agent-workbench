import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { PlanStep, ToolDetails } from '@shared/contract'
import { SKILL_NAMES, SKILLS } from '../skills'

const STEP_STATUS = Type.Union([
  Type.Literal('pending'),
  Type.Literal('active'),
  Type.Literal('done'),
  Type.Literal('blocked'),
])

const stepSchema = Type.Object({
  title: Type.String({ maxLength: 160, description: 'One short step.' }),
  status: Type.Optional(STEP_STATUS),
  detail: Type.Optional(Type.String({ maxLength: 320 })),
})

function details(view: ToolDetails['view'], target: string, note: string | null): ToolDetails {
  return { target, note, view, ms: 0, status: 'done' }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function planTool() {
  return defineTool({
    name: 'plan',
    description:
      'Publish or update the investigation plan the user sees. Use it when the work has several distinct steps; omit it for a short read. Keep it to 1–6 short steps. The plan is process, not a transcript.',
    parameters: Type.Object({
      steps: Type.Array(stepSchema, { minItems: 1, maxItems: 6 }),
      note: Type.Optional(Type.String({ maxLength: 300 })),
    }),
    execute: async (args) => {
      const steps: PlanStep[] = (
        args.steps as { title?: unknown; status?: unknown; detail?: unknown }[]
      )
        .map((step) => {
          const status: PlanStep['status'] =
            step.status === 'active' ||
            step.status === 'done' ||
            step.status === 'blocked' ||
            step.status === 'pending'
              ? step.status
              : 'pending'
          return {
            title: text(step.title, 160),
            status,
            ...(text(step.detail, 320) ? { detail: text(step.detail, 320) } : {}),
          }
        })
        .filter((step) => step.title)
        .slice(0, 6)
      const note = text(args.note, 300) || undefined
      return {
        output: [
          {
            type: 'text' as const,
            text: `Plan recorded with ${steps.length} step${steps.length === 1 ? '' : 's'}. The window shows it while you work.`,
          },
        ],
        details: details(
          { kind: 'plan', steps, ...(note ? { note } : {}) },
          'investigation',
          steps.length ? `${steps.length} steps` : null,
        ) as never,
      }
    },
  })
}

export function skillTool() {
  return defineTool({
    name: 'skill',
    description:
      'Load one method when the question needs a workflow, a compatibility rule or a safety detail. Omit name to list the four methods. This returns documentation, not storage evidence.',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ maxLength: 80 })),
    }),
    execute: async (args) => {
      const wanted = text(args.name, 80).toLowerCase()
      const skill = wanted ? SKILLS[wanted] : undefined
      if (wanted && !skill) {
        return {
          output: [
            {
              type: 'text' as const,
              text: `No method named "${wanted}". Available: ${SKILL_NAMES.join(', ')}.`,
            },
          ],
          isError: true,
          details: {
            target: wanted,
            note: 'Unknown method',
            view: null,
            ms: 0,
            status: 'failed',
          } as never,
        }
      }
      if (!skill) {
        return {
          output: [
            {
              type: 'text' as const,
              text: SKILL_NAMES.map((name) => {
                const item = SKILLS[name]!
                return `${item.name} — ${item.title}: ${item.description}`
              }).join('\n'),
            },
          ],
          details: details(
            {
              kind: 'skill',
              name: 'index',
              title: 'Methods',
              description: 'Available methods',
              body: SKILL_NAMES.join(', '),
            },
            'methods',
            `${SKILL_NAMES.length} methods`,
          ) as never,
        }
      }
      return {
        output: [{ type: 'text' as const, text: skill.body }],
        details: details(
          {
            kind: 'skill',
            name: skill.name,
            title: skill.title,
            description: skill.description,
            body: skill.body,
          },
          skill.name,
          skill.title,
        ) as never,
      }
    },
  })
}
