import { arr, int, lit, obj, opt, str, union, unknown } from '@earendil-works/pi-schema'
import type { ViewDoc } from '@shared/contract'
import { agentTool, type ToolDeps } from './policy'

/** The agent's durable files and SQL across tasks. */
export function workspaceTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'workspace',
    description:
      'Your workspace: a folder you own across every task, that the user can open. Keep what you learn there and organise it as you see fit. By convention: notes/ (what you know about the user\'s accounts and decisions), skills/ (Markdown with name and description front matter; listed in your prompt in later turns), data/ (datasets), scripts/ (JavaScript a query can run with run({path, args})), board/ (a <name>.view.json file holding {title, doc: ViewDoc} is pinned on the user\'s board; write it again to refresh it), exports/ (files for the user; each gets a link in the conversation). db.sqlite is your own SQL database: `sql` runs one statement on it, reads and writes. Paths are relative. Secrets are redacted when written. Read a long file in pieces with `more` (evidence "workspace:<path>").',
    parameters: obj({
      action: union([
        lit('list'),
        lit('read'),
        lit('write'),
        lit('append'),
        lit('move'),
        lit('delete'),
        lit('search'),
        lit('sql'),
      ]),
      path: opt(str({ description: 'A relative path, e.g. notes/accounts.md.' })),
      to: opt(str({ description: 'For move: the new path.' })),
      content: opt(str({ description: 'For write and append.' })),
      text: opt(str({ description: 'For search: the text to find.' })),
      sql: opt(str({ description: 'For sql: one statement on db.sqlite.' })),
      params: opt(arr(unknown(), { description: 'For sql: bound parameters.' })),
      depth: opt(int({ minimum: 1, description: 'For list: how many folder levels (default 2).' })),
    }),
    target: (args) => `${args.action}${args.path ? ` · ${args.path}` : ''}`,
    run: async (args) => {
      const ws = deps.workspace
      if (!ws) throw new Error('No workspace is available in this build.')
      const path = args.path ?? ''
      const need = (value: string | undefined, name: string) => {
        if (value === undefined || value === '')
          throw new Error(`workspace ${args.action} needs ${name}.`)
        return value
      }
      switch (args.action) {
        case 'list': {
          const entries = ws.list(path, args.depth ?? 2)
          return {
            model: entries.length
              ? entries
                  .map((entry) =>
                    entry.kind === 'dir'
                      ? `${entry.path}/`
                      : `${entry.path} (${entry.bytes.toLocaleString('en-US')} bytes, ${entry.modifiedAt.slice(0, 16)})`,
                  )
                  .join('\n')
              : '(empty)',
            note: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
            view: {
              kind: 'raw' as const,
              title: `Workspace${path ? ` · ${path}` : ''}`,
              value: entries,
            },
          }
        }
        case 'read': {
          const text = ws.read(need(args.path, 'a path'))
          return {
            model: text,
            note: `${text.length.toLocaleString('en-US')} characters`,
            view: viewOf(path, text),
          }
        }
        case 'write':
        case 'append': {
          const entry =
            args.action === 'write'
              ? ws.write(need(args.path, 'a path'), args.content ?? '')
              : ws.append(need(args.path, 'a path'), args.content ?? '')
          const exported = entry.path.startsWith('exports/')
          return {
            model: `${args.action === 'write' ? 'Wrote' : 'Appended to'} ${entry.path} (${entry.bytes.toLocaleString('en-US')} bytes).${exported ? ' The user sees a link to it.' : ''}${entry.path.startsWith('board/') ? ' It is on the board if it holds a valid view.' : ''}`,
            note: entry.path,
            view: exported
              ? { kind: 'export' as const, path: entry.path, bytes: entry.bytes }
              : viewOf(entry.path, args.content ?? ''),
          }
        }
        case 'move':
          ws.move(need(args.path, 'a path'), need(args.to, 'to'))
          return {
            model: `Moved ${args.path} to ${args.to}.`,
            note: `${args.path} → ${args.to}`,
            view: { kind: 'note' as const, text: `Moved ${args.path} to ${args.to}` },
          }
        case 'delete':
          ws.delete(need(args.path, 'a path'))
          return {
            model: `Deleted ${args.path}.`,
            note: 'deleted',
            view: { kind: 'note' as const, text: `Deleted ${args.path}` },
          }
        case 'search': {
          const hits = ws.search(need(args.text, 'text'), path)
          return {
            model: hits.length
              ? hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join('\n')
              : 'No match.',
            note: `${hits.length} match${hits.length === 1 ? '' : 'es'}`,
            view: { kind: 'raw' as const, title: `Search · ${args.text}`, value: hits },
          }
        }
        case 'sql': {
          const params = (args.params ?? []).map((value) =>
            value === null || typeof value === 'number' || typeof value === 'string'
              ? value
              : JSON.stringify(value),
          )
          const result = ws.sql(need(args.sql, 'a statement'), params)
          return {
            model: JSON.stringify(result, null, 1),
            note: Array.isArray(result) ? `${result.length} rows` : `${result.changes} changed`,
            view: { kind: 'raw' as const, title: 'db.sqlite', value: result },
          }
        }
      }
      throw new Error(`Unknown workspace action '${String(args.action)}'.`)
    },
  })
}

/** Markdown is shown rendered; anything else as text. */
function viewOf(path: string, text: string) {
  if (/\.(md|markdown)$/i.test(path)) {
    const doc: ViewDoc = { version: 1, blocks: [{ type: 'markdown', text }] }
    return { kind: 'render' as const, title: path, doc }
  }
  const doc: ViewDoc = {
    version: 1,
    blocks: [{ type: 'code', text: text.slice(0, 200_000), language: languageOf(path) }],
  }
  return { kind: 'render' as const, title: path, doc }
}

function languageOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  return (
    {
      js: 'javascript',
      ts: 'typescript',
      json: 'json',
      sql: 'sql',
      csv: 'csv',
      yml: 'yaml',
      yaml: 'yaml',
    }[ext] ?? 'text'
  )
}
