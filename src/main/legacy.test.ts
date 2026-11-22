import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { describe, expect, it } from 'vitest'
import { AppDb } from './db'
import { importLegacy } from './legacy'
import { MemoryStore } from './memory'
import { Workspace } from './workspace'

describe("42.0.0's stores", () => {
  it('move into the workspace once, losing nothing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sa-legacy-'))
    const memory = MemoryStore.open(join(dataDir, 'memory.sqlite'))
    memory.put({ key: 'vendor/account', value: { id: '999988887777' }, text: 'Trusted vendor' })
    memory.put({ key: 'scratch', value: 1, scope: 'task', conversationId: '7' })
    memory.close()
    mkdirSync(join(dataDir, 'skills'))
    writeFileSync(
      join(dataDir, 'skills', 'our-way.md'),
      '---\nname: our-way\ndescription: x\n---\nbody',
    )
    const db = await AppDb.open(await openNodeSqliteDatabase(join(dataDir, 'db.sqlite')))
    await db.upsertAgentTool({
      scope: 'user',
      conversationId: null,
      name: 'public_buckets',
      description: 'Buckets whose policy is public',
      schemaJson: '{"type":"object"}',
      code: 'return []',
    })
    const workspace = new Workspace(join(dataDir, 'workspace'))

    const moved = await importLegacy(dataDir, db, workspace)

    expect(moved.sort()).toEqual([
      'notes/memory/vendor-account.json',
      'scripts/public_buckets.js',
      'skills/our-way.md',
    ])
    expect(JSON.parse(workspace.read('notes/memory/vendor-account.json'))).toMatchObject({
      key: 'vendor/account',
      value: { id: '999988887777' },
    })
    expect(workspace.read('scripts/public_buckets.js')).toContain('return []')
    expect(workspace.read('scripts/public_buckets.schema.json')).toBe('{"type":"object"}')
    expect(workspace.skills.user().map((skill) => skill.name)).toEqual(['our-way'])
    // The old memory file is kept, renamed; the methods table is emptied.
    expect(existsSync(join(dataDir, 'memory.sqlite'))).toBe(false)
    expect(existsSync(join(dataDir, 'memory.sqlite.imported'))).toBe(true)
    expect(await db.listAgentTools()).toEqual([])
    // A second launch has nothing left to move.
    expect(await importLegacy(dataDir, db, workspace)).toEqual([])
  })
})
