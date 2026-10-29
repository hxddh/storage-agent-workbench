import type { Table } from '@shared/contract'
import { redact, redactView } from '../security/redact'
import { agentTool, type ToolDeps, Type } from './policy'

function table(rows: Record<string, unknown>[]): Table {
  const columns: string[] = []
  for (const row of rows)
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  return {
    columns,
    rows: rows.map((row) =>
      columns.map((column) => {
        const value = row[column]
        if (value === null || value === undefined) return null
        if (typeof value === 'string' || typeof value === 'number') return value
        if (typeof value === 'boolean') return value ? 'true' : 'false'
        return JSON.stringify(value)
      }),
    ),
  }
}

/** Durable memory, owned by the agent; the prompt only says it exists. */
export function memoryTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'memory',
    description:
      'Read and write durable JSON memory. Use it to remember facts, methods, decisions or a view across tasks, and to recall them before assuming. The window lists every document in Settings; the user can forget one.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('put'),
        Type.Literal('get'),
        Type.Literal('list'),
        Type.Literal('query'),
        Type.Literal('delete'),
      ]),
      key: Type.Optional(Type.String()),
      value: Type.Optional(Type.Unknown()),
      text: Type.Optional(Type.String({ description: 'Optional searchable text for the value.' })),
      tags: Type.Optional(Type.Array(Type.String())),
      scope: Type.Optional(Type.Union([Type.Literal('task'), Type.Literal('user')])),
      prefix: Type.Optional(Type.String()),
      tag: Type.Optional(Type.String()),
      sql: Type.Optional(Type.String({ description: 'One read-only SELECT over docs.' })),
      params: Type.Optional(Type.Array(Type.Unknown())),
      id: Type.Optional(Type.String()),
    }),
    target: (args) => `${args.action}${args.key ? ` · ${args.key}` : ''}`,
    run: async (args, run) => {
      const memory = deps.memory
      if (!memory) throw new Error('Memory is not available in this build.')
      const scope = args.scope === 'task' ? 'task' : 'user'
      const conversationId = scope === 'task' ? run.conversationId : null
      if (args.action === 'put') {
        if (!args.key) throw new Error('memory put needs a key.')
        const doc = memory.put({
          key: args.key,
          value: redactView(args.value ?? null),
          ...(args.text ? { text: redact(args.text) } : {}),
          ...(args.tags ? { tags: args.tags.map((tag) => redact(tag)) } : {}),
          scope,
          conversationId,
        })
        return {
          model: `Remembered ${doc.key}.`,
          view: { kind: 'note' as const, text: doc.key },
        }
      }
      if (args.action === 'get') {
        if (!args.key) throw new Error('memory get needs a key.')
        const doc = memory.get(args.key, scope, conversationId)
        if (!doc) throw new Error(`No memory document '${args.key}'.`)
        return {
          model: JSON.stringify(doc.value, null, 1),
          view: { kind: 'raw' as const, title: `memory · ${doc.key}`, value: doc.value },
        }
      }
      if (args.action === 'list') {
        const docs = memory.list({
          scope,
          conversationId,
          ...(args.prefix ? { prefix: args.prefix } : {}),
          ...(args.tag ? { tag: args.tag } : {}),
          limit: 100,
        })
        const rows = docs.map((doc) => ({
          key: doc.key,
          scope: doc.scope,
          text: doc.text.slice(0, 500),
          updatedAt: doc.updatedAt,
        }))
        return {
          model: JSON.stringify(rows, null, 1),
          view: { kind: 'memory' as const, title: 'Memory', table: table(rows) },
        }
      }
      if (args.action === 'query') {
        if (!args.sql) throw new Error('memory query needs sql.')
        const rows = memory.query(
          args.sql,
          Array.isArray(args.params) ? (args.params as (string | number | null)[]) : [],
        )
        return {
          model: JSON.stringify(rows, null, 1),
          view: { kind: 'memory' as const, title: 'Memory query', table: table(rows) },
        }
      }
      if (args.action === 'delete') {
        if (args.id) {
          memory.delete(args.id)
          return { model: 'Forgotten.', view: { kind: 'note' as const, text: 'Forgotten.' } }
        }
        if (!args.key) throw new Error('memory delete needs a key or id.')
        memory.deleteByKey(args.key, scope, conversationId)
        return { model: `Forgot ${args.key}.`, view: { kind: 'note' as const, text: args.key } }
      }
      throw new Error(`Unknown memory action '${String(args.action)}'.`)
    },
  })
}
