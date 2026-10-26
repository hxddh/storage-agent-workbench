import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { PlanStep, ReportBlock, ReportTone, ToolDetails } from '@shared/contract'
import { PLAYBOOK_NAMES, PLAYBOOKS } from '../playbooks'

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

const blockSchema = Type.Object({
  kind: Type.Union([
    Type.Literal('summary'),
    Type.Literal('callout'),
    Type.Literal('table'),
    Type.Literal('findings'),
    Type.Literal('timeline'),
    Type.Literal('plan'),
    Type.Literal('code'),
  ]),
  text: Type.Optional(Type.String({ maxLength: 1400 })),
  title: Type.Optional(Type.String({ maxLength: 160 })),
  tone: Type.Optional(
    Type.Union([
      Type.Literal('info'),
      Type.Literal('warn'),
      Type.Literal('danger'),
      Type.Literal('ok'),
    ]),
  ),
  evidence: Type.Optional(
    Type.Array(Type.String({ maxLength: 240 }), {
      maxItems: 8,
      description: 'Tool call ids from the <untrusted-data evidence="…"> attribute.',
    }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  bucket: Type.Optional(Type.String({ maxLength: 255 })),
  code: Type.Optional(Type.String({ maxLength: 120 })),
})

function details(view: ToolDetails['view'], target: string, note: string | null): ToolDetails {
  return { target, note, view, ms: 0, status: 'done' }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function evidence(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 8),
    ),
  ]
}

function reportBlocks(value: unknown): ReportBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: ReportBlock[] = []
  for (const raw of value.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const kind = item.kind
    const title = text(item.title, 160) || undefined
    if (kind === 'summary' || kind === 'callout') {
      const body = text(item.text, kind === 'summary' ? 1400 : 700)
      if (!body) continue
      const ids = evidence(item.evidence)
      if (kind === 'summary') blocks.push({ kind, text: body, evidence: ids })
      else {
        const tone: ReportTone =
          item.tone === 'warn' || item.tone === 'danger' || item.tone === 'ok' ? item.tone : 'info'
        blocks.push({
          kind,
          tone,
          text: body,
          evidence: ids,
          ...(title ? { title } : {}),
        })
      }
      continue
    }
    if (kind === 'findings') {
      const limit =
        typeof item.limit === 'number' && Number.isFinite(item.limit)
          ? Math.max(1, Math.min(20, Math.trunc(item.limit)))
          : undefined
      blocks.push({
        kind,
        ...(text(item.bucket, 255) ? { bucket: text(item.bucket, 255) } : {}),
        ...(text(item.code, 120) ? { code: text(item.code, 120) } : {}),
        ...(limit ? { limit } : {}),
      })
      continue
    }
    if (kind === 'table' || kind === 'timeline' || kind === 'plan' || kind === 'code') {
      const ids = evidence(item.evidence)
      if (!ids.length) continue
      const limit =
        typeof item.limit === 'number' && Number.isFinite(item.limit)
          ? Math.max(1, Math.min(20, Math.trunc(item.limit)))
          : undefined
      blocks.push({
        kind,
        evidence: ids,
        ...(title ? { title } : {}),
        ...(kind === 'table' || kind === 'timeline' ? (limit ? { limit } : {}) : {}),
      } as ReportBlock)
    }
  }
  return blocks
}

export function planTool() {
  return defineTool({
    name: 'plan',
    description:
      'Publish or update the investigation plan the user sees. Call it before the first read and after a step materially changes. Keep it to 3–6 short steps; the plan is a promise, not a transcript.',
    parameters: Type.Object({
      steps: Type.Array(stepSchema, { minItems: 1, maxItems: 12 }),
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
        .slice(0, 12)
      const note = text(args.note, 300) || undefined
      return {
        output: [
          {
            type: 'text' as const,
            text: `Plan recorded with ${steps.length} step${steps.length === 1 ? '' : 's'}. The window shows it above your answer.`,
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

export function reportTool() {
  return defineTool({
    name: 'report',
    description:
      'Compose the answer the window renders. Blocks are ordered. summary and callout carry your prose and cite the tool-call ids that support it; table, timeline, plan and code point at one tool result each; findings selects deterministic estate findings. Call it once when the investigation is ready; after it, write one short sentence at most.',
    parameters: Type.Object({
      title: Type.Optional(Type.String({ maxLength: 160 })),
      blocks: Type.Array(blockSchema, { minItems: 1, maxItems: 12 }),
    }),
    execute: async (args) => {
      const title = text(args.title, 160) || undefined
      const blocks = reportBlocks(args.blocks)
      if (!blocks.length) {
        const failed: ToolDetails = {
          target: 'answer',
          note: 'A report needs a summary, a callout or an evidence block.',
          view: null,
          ms: 0,
          status: 'failed',
        }
        return {
          output: [
            {
              type: 'text' as const,
              text: 'A report needs at least one valid block. Every data block needs the evidence id from a tool result.',
            },
          ],
          isError: true,
          details: failed as never,
        }
      }
      return {
        output: [
          {
            type: 'text' as const,
            text: `Report recorded with ${blocks.length} block${blocks.length === 1 ? '' : 's'}. The window renders it; do not repeat it in prose.`,
          },
        ],
        details: details(
          { kind: 'report', blocks, ...(title ? { title } : {}) },
          'answer',
          `${blocks.length} blocks`,
        ) as never,
      }
    },
  })
}

export function playbookTool() {
  return defineTool({
    name: 'playbook',
    description:
      'Read a field-guide card when the question needs a method, a compatibility rule or a safety detail. Omit card to list the available cards. This is documentation, not a storage read.',
    parameters: Type.Object({
      card: Type.Optional(Type.String({ maxLength: 80 })),
    }),
    execute: async (args) => {
      const wanted = text(args.card, 80).toLowerCase()
      const cards = wanted
        ? PLAYBOOKS[wanted]
          ? [{ name: wanted, body: PLAYBOOKS[wanted] }]
          : []
        : PLAYBOOK_NAMES.map((name) => ({ name, body: PLAYBOOKS[name] ?? '' }))
      if (wanted && !cards.length) {
        return {
          output: [
            {
              type: 'text' as const,
              text: `No card named "${wanted}". Available: ${PLAYBOOK_NAMES.join(', ')}.`,
            },
          ],
          isError: true,
          details: {
            target: wanted,
            note: 'Unknown playbook card',
            view: null,
            ms: 0,
            status: 'failed',
          } as never,
        }
      }
      const body = cards.map((card) => `## ${card.name}\n${card.body}`).join('\n\n')
      return {
        output: [{ type: 'text' as const, text: body }],
        details: details(
          { kind: 'playbook', cards },
          wanted || 'playbook',
          cards.length === 1 ? wanted : `${cards.length} cards`,
        ) as never,
      }
    },
  })
}
