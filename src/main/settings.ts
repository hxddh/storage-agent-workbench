import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, Lang, ModelProvider, Theme, ThinkingLevel } from '@shared/contract'

export type { ModelProvider }

export interface StoredModel {
  provider: ModelProvider
  modelId: string
  baseUrl: string
  contextWindow: number
  thinking: ThinkingLevel
  keyRef: string
}

export interface StoredSettings {
  language: Lang
  theme: Theme
  notify: boolean
  staleDays: number
  model: StoredModel | null
  lastTaskId: string | null
}

const DEFAULTS: StoredSettings = {
  language: 'en',
  theme: 'system',
  notify: true,
  staleDays: 7,
  model: null,
  lastTaskId: null,
}

const THINKING = new Set<ThinkingLevel>(['off', 'low', 'medium', 'high'])

export class Settings {
  private value: StoredSettings
  private readonly path: string

  constructor(dir: string) {
    this.path = join(dir, 'settings.json')
    this.value = this.load()
  }

  get(): StoredSettings {
    return this.value
  }

  public(): AppSettings {
    return {
      language: this.value.language,
      theme: this.value.theme,
      notify: this.value.notify,
      staleDays: this.value.staleDays,
    }
  }

  patch(patch: Partial<AppSettings>): void {
    if (patch.language === 'en' || patch.language === 'zh') this.value.language = patch.language
    if (patch.theme === 'light' || patch.theme === 'dark' || patch.theme === 'system')
      this.value.theme = patch.theme
    if (typeof patch.notify === 'boolean') this.value.notify = patch.notify
    if (typeof patch.staleDays === 'number' && Number.isFinite(patch.staleDays))
      this.value.staleDays = Math.max(1, Math.min(365, Math.round(patch.staleDays)))
    this.save()
  }

  setLastTask(id: string | null): void {
    if (this.value.lastTaskId === id) return
    this.value.lastTaskId = id
    this.save()
  }

  setModel(model: StoredModel | null): void {
    this.value.model = model
    this.save()
  }

  private load(): StoredSettings {
    try {
      if (!existsSync(this.path)) return { ...DEFAULTS }
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredSettings>
      const model = raw.model
        ? {
            ...raw.model,
            provider: (['openai', 'anthropic', 'compatible'] as const).includes(raw.model.provider)
              ? raw.model.provider
              : 'compatible',
            thinking: THINKING.has(raw.model.thinking) ? raw.model.thinking : 'off',
          }
        : null
      return {
        language: raw.language === 'zh' ? 'zh' : 'en',
        theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
        notify: raw.notify !== false,
        staleDays:
          typeof raw.staleDays === 'number' && raw.staleDays >= 1 && raw.staleDays <= 365
            ? Math.round(raw.staleDays)
            : 7,
        model,
        lastTaskId: typeof raw.lastTaskId === 'string' ? raw.lastTaskId : null,
      }
    } catch {
      return { ...DEFAULTS }
    }
  }

  private save(): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.value, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
