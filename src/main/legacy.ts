/**
 * 42.0.0 kept what the agent knew in four places: memory documents in
 * `memory.sqlite`, agent methods in the `agent_tools` table, the user's
 * skills in `<data>/skills/`, and kept datasets under `<data>/datasets/`.
 * 43 keeps all of it in the workspace. This moves it once, losing nothing:
 * the old memory file is renamed, not deleted.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppDb } from './db'
import { MemoryStore } from './memory'
import type { Workspace } from './workspace'

/** A key as a file name: what a person would type, nothing that climbs folders. */
function fileName(key: string): string {
  return (
    key
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 120) || 'note'
  )
}

/** A name not yet taken in the workspace: `name`, then `name-2`, … */
function free(workspace: Workspace, path: string): string {
  if (!existsSync(workspace.resolve(path))) return path
  const dot = path.lastIndexOf('.')
  const [stem, ext] =
    dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, '']
  for (let n = 2; ; n++) {
    const next = `${stem}-${n}${ext}`
    if (!existsSync(workspace.resolve(next))) return next
  }
}

export async function importLegacy(
  dataDir: string,
  db: AppDb,
  workspace: Workspace,
): Promise<string[]> {
  const moved: string[] = []

  // Memory documents the user kept: one JSON file each, with where it came from.
  const memoryFile = join(dataDir, 'memory.sqlite')
  if (existsSync(memoryFile)) {
    const store = MemoryStore.open(memoryFile)
    try {
      for (const doc of store.list({ scope: 'user', limit: 100_000 })) {
        const path = free(workspace, `notes/memory/${fileName(doc.key)}.json`)
        workspace.write(
          path,
          JSON.stringify(
            {
              key: doc.key,
              value: doc.value,
              text: doc.text,
              tags: doc.tags,
              writtenBy: doc.origin ? `task ${doc.origin}` : null,
              updatedAt: doc.updatedAt,
            },
            null,
            2,
          ),
        )
        moved.push(path)
      }
    } finally {
      store.close()
    }
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(memoryFile + suffix))
        renameSync(memoryFile + suffix, `${memoryFile}.imported${suffix}`)
  }

  // The user's own skills.
  const skillsDir = join(dataDir, 'skills')
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const name of readdirSync(skillsDir).filter((file) => file.endsWith('.md'))) {
      const path = free(workspace, `skills/${name}`)
      const target = workspace.resolve(path)
      mkdirSync(dirname(target), { recursive: true })
      renameSync(join(skillsDir, name), target)
      moved.push(path)
    }
  }

  // Agent methods the user kept: the body as a script, its schema beside it.
  for (const row of await db.listAgentTools()) {
    if (row.scope !== 'user') continue
    const path = free(workspace, `scripts/${fileName(row.name)}.js`)
    workspace.write(
      path,
      `// ${row.description || row.name}\n// Arguments: see ${path.replace(/\.js$/, '.schema.json')}; run with run({path: '${path}', args}).\n${row.code}\n`,
    )
    workspace.write(path.replace(/\.js$/, '.schema.json'), row.schema_json)
    await db.deleteAgentTool(row.id)
    moved.push(path)
  }

  return moved
}
