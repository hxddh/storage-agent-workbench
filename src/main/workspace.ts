/**
 * The agent's workspace: one folder it owns across tasks, and the user can
 * open. Notes, skills, datasets, scripts, the board and exports are files in
 * it, organised as the agent sees fit; `db.sqlite` is its own SQL store.
 *
 * The app keeps three promises here and decides nothing else: a path never
 * leaves the folder, a secret is redacted before it is written, and the
 * agent's SQL reaches only its own file.
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ViewDoc } from '@shared/view'
import { checkViewDoc } from '@shared/view'
import { redact } from './security/redact'
import { Skills } from './skills'

export interface WorkspaceEntry {
  path: string
  kind: 'file' | 'dir'
  bytes: number
  modifiedAt: string
}

export interface BoardItem {
  path: string
  title: string
  doc: ViewDoc
  modifiedAt: string
}

/** The folders the agent is told about; it may make any others. */
export const CONVENTIONS = ['notes', 'skills', 'data', 'scripts', 'board', 'exports'] as const

/** Statements the agent's SQL may not run: they reach beyond its own file. */
const FORBIDDEN_SQL = /\b(attach|detach)\b|load_extension|\bvacuum\s+into\b/i

export class Workspace {
  readonly skills: Skills

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    this.skills = new Skills(join(dir, 'skills'))
  }

  /**
   * A workspace path as an absolute file path, or a refusal that says why. A
   * path is relative, has no `..` that climbs out, and does not lead out of
   * the folder through a symbolic link.
   */
  resolve(path: string): string {
    const clean = String(path ?? '')
      .replaceAll('\\', '/')
      .replace(/^\.\/+/, '')
    if (!clean || clean === '.') return this.dir
    if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean))
      throw new Error(
        `"${path}" is absolute; workspace paths are relative, e.g. notes/accounts.md.`,
      )
    const full = resolve(this.dir, clean)
    const inside = (target: string) => target === this.dir || target.startsWith(this.dir + sep)
    if (!inside(full)) throw new Error(`"${path}" leads outside the workspace.`)
    // The nearest existing ancestor must also be inside once links are followed.
    let probe = full
    while (!existsSync(probe) && probe !== this.dir) probe = dirname(probe)
    const real = realpathSync(probe)
    const root = realpathSync(this.dir)
    if (real !== root && !real.startsWith(root + sep))
      throw new Error(`"${path}" leads outside the workspace through a link.`)
    return full
  }

  relative(full: string): string {
    return relative(this.dir, full).split(sep).join('/')
  }

  list(path = '', depth = 2): WorkspaceEntry[] {
    const root = this.resolve(path)
    if (!existsSync(root)) throw new Error(`Nothing at "${path}" in the workspace.`)
    const out: WorkspaceEntry[] = []
    const walk = (dir: string, level: number) => {
      for (const name of readdirSync(dir).sort()) {
        if (name === 'db.sqlite-wal' || name === 'db.sqlite-shm') continue
        const full = join(dir, name)
        const info = lstatSync(full)
        if (info.isSymbolicLink()) continue
        const kind = info.isDirectory() ? 'dir' : 'file'
        out.push({
          path: this.relative(full),
          kind,
          bytes: kind === 'file' ? info.size : 0,
          modifiedAt: info.mtime.toISOString(),
        })
        if (kind === 'dir' && level < depth) walk(full, level + 1)
      }
    }
    if (statSync(root).isDirectory()) walk(root, 1)
    else {
      const info = statSync(root)
      out.push({
        path: this.relative(root),
        kind: 'file',
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      })
    }
    return out
  }

  read(path: string): string {
    const full = this.resolve(path)
    if (!existsSync(full) || !statSync(full).isFile())
      throw new Error(`No file "${path}" in the workspace.`)
    return readFileSync(full, 'utf8')
  }

  /** Write a file whole; its parent folders are made. Secrets are redacted first. */
  write(path: string, content: string): WorkspaceEntry {
    const full = this.resolve(path)
    if (full === this.dir) throw new Error('Give a file path, e.g. notes/accounts.md.')
    if (existsSync(full) && statSync(full).isDirectory()) throw new Error(`"${path}" is a folder.`)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, redact(String(content)), 'utf8')
    return this.list(path)[0]!
  }

  append(path: string, content: string): WorkspaceEntry {
    const full = this.resolve(path)
    mkdirSync(dirname(full), { recursive: true })
    appendFileSync(full, redact(String(content)), 'utf8')
    return this.list(path)[0]!
  }

  move(from: string, to: string): void {
    const source = this.resolve(from)
    const target = this.resolve(to)
    if (!existsSync(source)) throw new Error(`Nothing at "${from}" in the workspace.`)
    if (existsSync(target)) throw new Error(`"${to}" already exists.`)
    mkdirSync(dirname(target), { recursive: true })
    renameSync(source, target)
  }

  delete(path: string): void {
    const full = this.resolve(path)
    if (full === this.dir) throw new Error('The workspace itself cannot be deleted.')
    if (!existsSync(full)) throw new Error(`Nothing at "${path}" in the workspace.`)
    rmSync(full, { recursive: true, force: true })
  }

  /** Lines that contain the text, in every text file under a path. */
  search(text: string, path = '', limit = 200): { path: string; line: number; text: string }[] {
    const needle = String(text ?? '').toLowerCase()
    if (!needle) throw new Error('search needs text.')
    const hits: { path: string; line: number; text: string }[] = []
    for (const entry of this.list(path, 16)) {
      if (entry.kind !== 'file' || entry.bytes > 8 * 1024 * 1024) continue
      if (/\.(sqlite|db|bin|png|jpe?g|gif|webp|gz|zip|parquet)$/i.test(entry.path)) continue
      const lines = readFileSync(join(this.dir, entry.path), 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (hits.length < limit && line.toLowerCase().includes(needle))
          hits.push({ path: entry.path, line: index + 1, text: line.slice(0, 400) })
      })
      if (hits.length >= limit) break
    }
    return hits
  }

  /**
   * One statement on the agent's own `db.sqlite`: reads and writes, nothing
   * that reaches another file. Strings written are redacted.
   */
  sql(
    statement: string,
    params: (string | number | null)[] = [],
  ):
    | Record<string, unknown>[]
    | {
        changes: number
      } {
    const text = String(statement ?? '').trim()
    if (!text) throw new Error('sql needs a statement.')
    if (FORBIDDEN_SQL.test(text))
      throw new Error(
        'ATTACH, DETACH, load_extension and VACUUM INTO reach beyond the workspace database.',
      )
    const db = new DatabaseSync(join(this.dir, 'db.sqlite'))
    try {
      const prepared = db.prepare(text)
      const values = params.map((value) => (typeof value === 'string' ? redact(value) : value))
      if (/^\s*(select|with|pragma\s+table_info|explain)\b/i.test(text))
        return prepared.all(...values) as Record<string, unknown>[]
      const result = prepared.run(...values)
      return { changes: Number(result.changes) }
    } finally {
      db.close()
    }
  }

  /** The views pinned to the board: every valid `board/*.view.json`, newest first. */
  board(): BoardItem[] {
    const dir = join(this.dir, 'board')
    if (!existsSync(dir)) return []
    const out: BoardItem[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.view.json')) continue
      const full = join(dir, name)
      try {
        const raw = JSON.parse(readFileSync(full, 'utf8')) as { title?: unknown; doc?: unknown }
        const checked = checkViewDoc(raw.doc ?? raw)
        if (!checked.doc) continue
        out.push({
          path: `board/${name}`,
          title: typeof raw.title === 'string' ? raw.title : name.replace(/\.view\.json$/, ''),
          doc: checked.doc,
          modifiedAt: statSync(full).mtime.toISOString(),
        })
      } catch {
        // A file that is not a view is not on the board.
      }
    }
    return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  }

  /** One line per conventional folder that holds something, for the prompt. */
  summary(): string {
    const parts: string[] = []
    for (const name of CONVENTIONS) {
      const full = join(this.dir, name)
      if (!existsSync(full)) continue
      const count = this.list(name, 8).filter((entry) => entry.kind === 'file').length
      if (count) parts.push(`${name}/ ${count} file${count === 1 ? '' : 's'}`)
    }
    if (existsSync(join(this.dir, 'db.sqlite'))) parts.push('db.sqlite')
    return parts.join(', ')
  }
}
