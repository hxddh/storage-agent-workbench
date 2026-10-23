import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AttachmentRef, StagedFile } from '@shared/contract'

/** Files chosen in the dialog wait here until their message is sent. */
export class Staging {
  constructor(private readonly root: string) {}

  async stage(paths: string[]): Promise<StagedFile[]> {
    const out: StagedFile[] = []
    for (const path of paths.slice(0, 10)) {
      const token = randomUUID()
      const dir = join(this.root, token)
      await mkdir(dir, { recursive: true })
      const name = basename(path)
      const target = join(dir, name)
      await copyFile(path, target)
      const info = await stat(target)
      out.push({ name, bytes: info.size, token })
    }
    return out
  }

  async consume(
    tokens: string[],
    conversationId: string,
    uploadsDir: string,
  ): Promise<AttachmentRef[]> {
    const out: AttachmentRef[] = []
    if (tokens.length === 0) return out
    await mkdir(uploadsDir, { recursive: true })
    const existing = new Set(await readdir(uploadsDir))
    for (const token of tokens.slice(0, 10)) {
      if (!/^[0-9a-f-]{36}$/i.test(token)) continue
      const dir = join(this.root, token)
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        let final = name
        let counter = 1
        while (existing.has(final)) {
          const dot = name.lastIndexOf('.')
          final =
            dot > 0 ? `${name.slice(0, dot)}-${counter}${name.slice(dot)}` : `${name}-${counter}`
          counter += 1
        }
        existing.add(final)
        await rename(join(dir, name), join(uploadsDir, final))
        const info = await stat(join(uploadsDir, final))
        out.push({ name: final, bytes: info.size })
      }
      await rm(dir, { recursive: true, force: true })
    }
    void conversationId
    return out
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
    await mkdir(this.root, { recursive: true })
  }
}
