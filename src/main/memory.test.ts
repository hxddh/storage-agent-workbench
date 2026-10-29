import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from './memory'

const file = () => join(mkdtempSync(join(tmpdir(), 'sa-memory-')), 'memory.sqlite')

describe('memory', () => {
  it('keeps every document and the task that wrote it', () => {
    const memory = MemoryStore.open(file())
    for (let i = 0; i < 600; i++) memory.put({ key: `k${i}`, value: i, origin: '7' })
    expect(memory.list()).toHaveLength(600)
    expect(memory.get('k1')?.origin).toBe('7')
  })

  it('matches % and _ in a search or prefix only as themselves', () => {
    const memory = MemoryStore.open(file())
    memory.put({ key: '100%_done', value: 'a' })
    memory.put({ key: '100x-done', value: 'b' })
    expect(memory.search('100%_').map((doc) => doc.key)).toEqual(['100%_done'])
    expect(memory.list({ prefix: '100%' }).map((doc) => doc.key)).toEqual(['100%_done'])
  })

  it('starts over from a file of any other layout', () => {
    const path = file()
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE docs (id TEXT PRIMARY KEY, key TEXT); INSERT INTO docs VALUES (1, 2)')
    old.close()
    const memory = MemoryStore.open(path)
    expect(memory.count()).toBe(0)
    memory.put({ key: 'k', value: 1 })
    expect(memory.count()).toBe(1)
  })
})
