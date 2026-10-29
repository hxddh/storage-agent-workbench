import { operationShape, operationsOf, SERVICES } from '../s3/api'
import { agentTool, type ToolDeps, Type } from './policy'

/** What the agent can ask the environment; it decides when to ask. */
export function discoverTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'discover',
    description:
      'Inspect the environment: AWS services and their read operations, the tools available to you, or an agent-authored method. Use it when you need a capability you do not know; it reads no storage.',
    parameters: Type.Object({
      kind: Type.Optional(
        Type.Union([Type.Literal('aws'), Type.Literal('tools')], {
          description: 'aws (default) or tools.',
        }),
      ),
      service: Type.Optional(Type.String({ description: 'An AWS service name, e.g. s3.' })),
      operation: Type.Optional(Type.String({ description: 'An operation to inspect.' })),
      tool: Type.Optional(Type.String({ description: 'An agent-authored tool name.' })),
    }),
    target: (args) =>
      [args.kind ?? 'aws', args.service, args.operation ?? args.tool].filter(Boolean).join(' '),
    run: async (args, run) => {
      const kind = args.kind ?? 'aws'
      if (kind === 'tools') {
        const saved = (await deps.db.listAgentTools(run.conversationId)).map((row) => ({
          name: row.name,
          description: row.description,
          schema: safeJson(row.schema_json),
          scope: row.scope,
          updatedAt: row.updated_at,
        }))
        const tools = [
          ...(deps.catalog ?? []).map(({ name, description }) => ({
            name,
            description,
            scope: 'builtin',
          })),
          ...saved,
        ]
        if (args.tool) {
          const tool = tools.find((item) => item.name === args.tool)
          if (!tool) throw new Error(`No tool named '${args.tool}'.`)
          return {
            model: JSON.stringify(tool, null, 1),
            view: { kind: 'raw' as const, title: `Tool · ${args.tool}`, value: tool },
          }
        }
        return {
          model: JSON.stringify(tools, null, 1),
          view: { kind: 'raw' as const, title: 'Tools', value: tools },
        }
      }

      const service = args.service?.toLowerCase()
      if (!service) {
        return {
          model: JSON.stringify({ services: SERVICES }, null, 1),
          view: { kind: 'raw' as const, title: 'AWS services', value: { services: SERVICES } },
        }
      }
      if (!SERVICES.includes(service))
        throw new Error(`Service '${service}' is not available. Available: ${SERVICES.join(', ')}.`)
      const operations = operationsOf(service)
      if (args.operation) {
        if (!operations.includes(args.operation))
          throw new Error(
            `${service} has no read operation '${args.operation}'. Reads: ${operations.join(', ')}.`,
          )
        const shape = operationShape(service, args.operation)
        const value = {
          service,
          operation: args.operation,
          input: shape.input,
          output: shape.output,
        }
        return {
          model: JSON.stringify(value, null, 1),
          view: { kind: 'raw' as const, title: `${service} ${args.operation}`, value },
        }
      }
      return {
        model: JSON.stringify({ service, operations }, null, 1),
        view: { kind: 'raw' as const, title: `${service} reads`, value: { service, operations } },
      }
    },
  })
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
