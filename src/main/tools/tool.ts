import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import type { Chart } from '@shared/contract'
import { viewDoc, viewText } from '@shared/view'
import Ajv from 'ajv'
import { scrub } from '../s3/api'
import { redact } from '../security/redact'
import { agentTool, providerParam, type ToolDeps, Type } from './policy'
import { isRows, sandboxPrimitives, toTable } from './query'

const NAME = /^[a-z][a-z0-9_]{1,48}$/

/** The agent's own methods: code in the same read-only sandbox as `query`. */
export function toolTool(deps: ToolDeps) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  return agentTool(deps, {
    name: 'tool',
    description:
      'Write, list, run or delete a reusable method. A method is a JSON Schema and a JavaScript body; it runs in the same sandbox as `query` with only read-only primitives, no network, files, process or timers. The body reads its validated arguments as `args`. Save a method when a question will recur; run it by name.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('save'),
        Type.Literal('list'),
        Type.Literal('run'),
        Type.Literal('delete'),
      ]),
      name: Type.Optional(Type.String({ description: 'Lowercase name: a-z, 0-9, _.' })),
      description: Type.Optional(Type.String()),
      schema: Type.Optional(
        Type.Unknown({ description: 'A JSON Schema object for the arguments.' }),
      ),
      code: Type.Optional(Type.String({ description: 'The JavaScript body; `return` the value.' })),
      scope: Type.Optional(Type.Union([Type.Literal('task'), Type.Literal('user')])),
      args: Type.Optional(Type.Unknown()),
      provider_id: providerParam,
      memory_mb: Type.Optional(Type.Integer({ minimum: 16 })),
    }),
    target: (args) => `${args.action}${args.name ? ` · ${args.name}` : ''}`,
    run: async (args, run) => {
      if (args.action === 'save') {
        const name = args.name?.trim() ?? ''
        if (!NAME.test(name))
          throw new Error('tool name must start with a letter and use a-z, 0-9, _ (2–49 chars).')
        if (!args.code?.trim()) throw new Error('tool code is required.')
        const schema = args.schema ?? { type: 'object', additionalProperties: true }
        if (!schema || typeof schema !== 'object' || Array.isArray(schema))
          throw new Error('tool schema must be a JSON Schema object.')
        // Credential-shaped text never reaches SQLite; an account in an ARN is
        // stored as `<account>`, which `call` fills in when the method runs.
        const stored = (text: string) => redact(text).replaceAll('[account]', '<account>')
        const schemaJson = stored(JSON.stringify(schema))
        const scope = args.scope === 'task' ? 'task' : 'user'
        const row = await deps.db.upsertAgentTool({
          scope,
          conversationId: scope === 'task' ? run.conversationId : null,
          name,
          description: stored(args.description?.trim() ?? ''),
          schemaJson,
          code: stored(args.code),
        })
        return {
          model: `Saved tool '${row.name}' (${row.scope}).`,
          note: row.scope,
          view: { kind: 'note' as const, text: row.name },
        }
      }

      if (args.action === 'list') {
        const rows = await deps.db.listAgentTools(run.conversationId)
        const list = rows.map((row) => ({
          name: row.name,
          description: row.description,
          scope: row.scope,
          updatedAt: row.updated_at,
        }))
        return {
          model: JSON.stringify(list, null, 1),
          view: { kind: 'raw' as const, title: 'Agent tools', value: list },
        }
      }

      if (args.action === 'delete') {
        const name = args.name?.trim() ?? ''
        if (!name) throw new Error('tool delete needs a name.')
        const row = await deps.db.getAgentTool(name, run.conversationId)
        if (!row) throw new Error(`No tool named '${name}'.`)
        await deps.db.deleteAgentTool(row.id)
        return { model: `Deleted tool '${name}'.`, view: { kind: 'note' as const, text: name } }
      }

      // run
      const name = args.name?.trim() ?? ''
      const row = await deps.db.getAgentTool(name, run.conversationId)
      if (!row) throw new Error(`No tool named '${name}'.`)
      let schema: unknown
      try {
        schema = JSON.parse(row.schema_json)
      } catch {
        throw new Error(`Tool '${name}' has an invalid schema.`)
      }
      let validate: ReturnType<typeof ajv.compile>
      try {
        validate = ajv.compile(schema as object)
      } catch (error) {
        throw new Error(
          `Tool '${name}' schema does not compile: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const input = (args.args ?? {}) as Record<string, unknown>
      if (!validate(input))
        throw new Error(
          `Tool '${name}' arguments do not match its schema: ${ajv.errorsText(validate.errors)}`,
        )
      const { config } = await run.provider(args.provider_id)
      const calls = { count: 0 }
      const touched = new Set<string>()
      const sandbox = new CodemodeSandbox({
        tools: sandboxPrimitives({
          deps,
          config,
          signal: run.signal,
          calls,
          touched,
          conversationId: run.conversationId,
          datasets: new Map(),
        }),
        timeoutMs: 2_147_483_647,
        memoryLimitBytes: (args.memory_mb ?? 1024) * 1024 * 1024,
      })
      let result: Awaited<ReturnType<CodemodeSandbox['execute']>>
      try {
        const source = `const args = ${JSON.stringify(input)};\n${row.code}`
        result = await sandbox.execute(source, { signal: run.signal })
      } finally {
        await sandbox.close().catch(() => undefined)
      }
      const output = result.output
        .filter((item) => item.type === 'text')
        .map((item) => (item as { text: string }).text)
        .join('\n')
      if (!result.ok) {
        const reason =
          result.error.kind === 'aborted'
            ? 'The method was stopped.'
            : `${result.error.name ?? 'Error'}: ${result.error.message}`
        throw new Error(`${reason}${output ? `\nOutput before it failed:\n${output}` : ''}`)
      }
      const rendered = viewDoc(result.value)
      if (rendered)
        return {
          model: viewText(rendered),
          note: `${rendered.blocks.length} view block(s)`,
          view: { kind: 'render' as const, title: name, doc: rendered },
        }
      if (!isRows(result.value)) {
        const value = scrub(result.value ?? null)
        return {
          model: [
            `${name}: value from ${calls.count} read-only call(s).`,
            JSON.stringify(value, null, 1),
            ...(output ? [`Output:\n${output}`] : []),
          ].join('\n'),
          note: `${calls.count} call${calls.count === 1 ? '' : 's'}`,
          view: { kind: 'raw' as const, title: name, value },
        }
      }
      const { table: rows, chart } = toTable(result.value)
      const text = [
        rows.columns.join('\t'),
        ...rows.rows.map((row) =>
          row.map((value) => (value === null ? '' : String(value))).join('\t'),
        ),
      ].join('\n')
      return {
        model: [
          `${name}: ${rows.rows.length} row(s) from ${calls.count} read-only call(s).`,
          rows.rows.length ? text : 'The method returned no rows.',
          ...(output ? [`Output:\n${output}`] : []),
        ].join('\n'),
        note: `${rows.rows.length} row${rows.rows.length === 1 ? '' : 's'}`,
        view: {
          kind: 'query' as const,
          providerId: config.id,
          title: name,
          code: row.code,
          rows:
            rows.rows.length > 10_000
              ? { ...rows, rows: rows.rows.slice(0, 10_000), truncated: true }
              : rows,
          chart: chart as Chart | null,
          output: output || null,
          calls: calls.count,
          buckets: [...touched],
        },
      }
    },
  })
}
