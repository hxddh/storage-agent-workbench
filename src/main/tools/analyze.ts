import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  AggregationError,
  aggregate,
  chartFromAggregate,
  countRows,
  type DatasetKind,
  preview,
  tableFromAggregate,
} from '../analysis/aggregate'
import { datasetBytes, importDataset } from '../analysis/import'
import { agentTool, type ToolDeps, Type } from './policy'

const ACCESS_METRICS = [
  'count',
  'sum_bytes',
  'avg_bytes',
  'min_bytes',
  'max_bytes',
  'avg_latency_ms',
  'p50_latency_ms',
  'p95_latency_ms',
  'p99_latency_ms',
  'max_latency_ms',
  'distinct_ips',
  'distinct_keys',
]

const INVENTORY_METRICS = [
  'count',
  'total_size',
  'avg_size',
  'max_size',
  'min_size',
  'distinct_prefixes',
  'distinct_storage_classes',
]

const ACCESS_DIMS = [
  'status_code',
  'method',
  'key',
  'path',
  'prefix',
  'user_agent',
  'client_ip_masked',
  'error_code',
  'hour',
  'day',
  'weekday',
]

const INVENTORY_DIMS = ['bucket', 'prefix', 'storage_class']

export function analyzeTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'analyze',
    description:
      'Analyze a file the user attached: an S3/CloudFront/ALB access log or an object inventory (CSV, TSV, JSONL or Parquet). Imports it into a local analytical database once, then answers whitelisted aggregates. Raw rows never reach the model.',
    parameters: Type.Object({
      file: Type.String({ description: 'Attached file name.' }),
      kind: Type.Optional(
        Type.Union([Type.Literal('access_log'), Type.Literal('inventory')], {
          description: 'Dataset type; detected from the file when omitted.',
        }),
      ),
      metric: Type.Optional(
        Type.String({
          description: `Aggregate. Access logs: ${ACCESS_METRICS.join(', ')}. Inventories: ${INVENTORY_METRICS.join(', ')}.`,
        }),
      ),
      group_by: Type.Optional(
        Type.String({
          description: `Dimension. Access logs: ${ACCESS_DIMS.join(', ')}. Inventories: ${INVENTORY_DIMS.join(', ')}.`,
        }),
      ),
      filters: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: 'Equality filters on one of the dimensions.',
        }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    timeoutMs: 240_000,
    target: (args) => args.file,
    run: async (args, run) => {
      const uploads = deps.uploadsDir(run.conversationId)
      const path = join(uploads, args.file)
      if (!existsSync(path)) {
        const available = existsSync(uploads) ? readdirSync(uploads).slice(0, 20) : []
        throw new Error(
          available.length
            ? `No attached file named '${args.file}'. Available: ${available.join(', ')}.`
            : 'No files are attached to this task.',
        )
      }
      const stat = statSync(path)
      const id = createHash('sha1')
        .update(`${run.conversationId}:${args.file}:${stat.size}:${stat.mtimeMs}`)
        .digest('hex')
        .slice(0, 16)
      const datasetPath = join(deps.datasetsDir(run.conversationId), `${id}.sqlite`)
      let kind: DatasetKind = (args.kind ?? 'access_log') as DatasetKind
      let rows = 0
      let truncated = false
      if (!existsSync(datasetPath)) {
        run.progress(`Importing ${args.file}`)
        const result = await importDataset({
          filePath: path,
          destPath: datasetPath,
          ...(args.kind ? { kind: args.kind } : {}),
        })
        kind = result.kind
        rows = result.rows
        truncated = result.truncated
        await deps.db.insertDataset({
          id,
          conversation_id: run.conversationId,
          kind,
          path: datasetPath,
          rows,
          bytes: datasetBytes(datasetPath),
        })
      } else {
        rows = countRows(datasetPath, kind)
      }

      if (!args.metric) {
        const sample = preview(datasetPath, kind, 5)
        return {
          model: `Imported ${rows} row(s) from ${args.file} as ${kind}${truncated ? ' (truncated at 2,000,000 rows)' : ''}. Columns: ${sample.columns.join(', ')}.`,
          note: `${rows} row${rows === 1 ? '' : 's'}`,
          view: {
            kind: 'analyze' as const,
            dataset: args.file,
            rows: sample,
            chart: null,
            note: 'Import complete',
          },
        }
      }

      let result: ReturnType<typeof aggregate>
      try {
        result = aggregate(datasetPath, kind, {
          metric: args.metric,
          groupBy: args.group_by ?? null,
          filters: args.filters ?? null,
          limit: args.limit ?? 20,
        })
      } catch (error) {
        if (error instanceof AggregationError) throw new Error(error.message)
        throw error
      }
      const table = tableFromAggregate(result)
      const unit =
        args.metric.includes('bytes') || args.metric.includes('size') ? 'bytes' : undefined
      const chart = chartFromAggregate(result, unit)
      const headline = result.groups
        ? `${args.metric} by ${result.groupBy}: ${result.groups
            .slice(0, 6)
            .map((g) => `${g.group}=${g.value}`)
            .join(', ')}`
        : `${args.metric}: ${result.value ?? 'no data'}`
      return {
        model: `${headline}${result.truncated ? ' (top groups only)' : ''}`,
        note: result.groups
          ? `${result.groups.length} group${result.groups.length === 1 ? '' : 's'}`
          : String(result.value ?? '—'),
        view: {
          kind: 'analyze' as const,
          dataset: args.file,
          rows: table,
          chart,
          note: null,
        },
      }
    },
  })
}
