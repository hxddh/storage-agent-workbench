import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'

/**
 * Secrets never reach SQLite in the clear. Preferred: the OS keychain through
 * Electron's safeStorage. Fallback (headless Linux without a keyring): a local
 * AES-256-GCM key in a 0600 file, so the stored value is still ciphertext.
 */
export class Vault {
  private fallbackKey: Buffer | null = null

  constructor(private readonly dir: string) {}

  available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  seal(plain: string): string {
    if (this.available()) {
      return `safe:${safeStorage.encryptString(plain).toString('base64')}`
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `aes:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
  }

  open(ref: string): string {
    if (ref.startsWith('safe:')) {
      return safeStorage.decryptString(Buffer.from(ref.slice(5), 'base64'))
    }
    if (ref.startsWith('aes:')) {
      const [, iv, tag, ct] = ref.split(':')
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv!, 'base64'))
      decipher.setAuthTag(Buffer.from(tag!, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(ct!, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    }
    throw new Error('Unknown secret reference')
  }

  private key(): Buffer {
    if (this.fallbackKey) return this.fallbackKey
    const path = join(this.dir, '.vault-key')
    mkdirSync(this.dir, { recursive: true })
    if (existsSync(path)) {
      this.fallbackKey = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
    } else {
      const key = randomBytes(32)
      writeFileSync(path, key.toString('base64'), { mode: 0o600 })
      try {
        chmodSync(path, 0o600)
      } catch {
        // Windows has no POSIX mode; the file still lives in the user profile.
      }
      this.fallbackKey = key
    }
    return this.fallbackKey
  }
}
