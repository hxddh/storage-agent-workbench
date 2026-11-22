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
  openAtLogin: boolean
  model: StoredModel | null
  /** Every model saved, each with its own key; the default is one of them. */
  models: StoredModel[]
  lastTaskId: string | null
}

/** An endpoint as configured: the base URL without a trailing slash; empty means the provider's own. */
export function endpointOf(baseUrl: string | null | undefined): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '')
}

/** Two configurations name the same model when provider, endpoint and id match. */
export function sameModel(
  a: Pick<StoredModel, 'provider' | 'modelId' | 'baseUrl'>,
  b: { provider: string; modelId: string; baseUrl?: string | null },
): boolean {
  return (
    a.provider === b.provider && a.modelId === b.modelId && (a.baseUrl || '') === (b.baseUrl || '')
  )
}

const DEFAULTS: StoredSettings = {
  language: 'en',
  theme: 'system',
  notify: true,
  openAtLogin: false,
  model: null,
  models: [],
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
      openAtLogin: this.value.openAtLogin,
    }
  }

  patch(patch: Partial<AppSettings>): void {
    if (patch.language === 'en' || patch.language === 'zh') this.value.language = patch.language
    if (patch.theme === 'light' || patch.theme === 'dark' || patch.theme === 'system')
      this.value.theme = patch.theme
    if (typeof patch.notify === 'boolean') this.value.notify = patch.notify
    if (typeof patch.openAtLogin === 'boolean') this.value.openAtLogin = patch.openAtLogin
    this.save()
  }

  setLastTask(id: string | null): void {
    if (this.value.lastTaskId === id) return
    this.value.lastTaskId = id
    this.save()
  }

  /** Make a model the default; it is kept among the saved models with its key. */
  setModel(model: StoredModel | null): void {
    if (model) {
      this.value.models = [...this.value.models.filter((item) => !sameModel(item, model)), model]
    } else if (this.value.model) {
      const current = this.value.model
      this.value.models = this.value.models.filter((item) => !sameModel(item, current))
    }
    this.value.model = model
    this.save()
  }

  /**
   * A saved key for this provider at this endpoint, and only there: a key is
   * never sent to a base URL other than the one it was saved for.
   */
  keyFor(provider: string, baseUrl: string | null | undefined): string | null {
    const endpoint = endpointOf(baseUrl)
    const match = [this.value.model, ...this.value.models].find(
      (item) => item && item.provider === provider && endpointOf(item.baseUrl) === endpoint,
    )
    return match?.keyRef ?? null
  }

  /** The saved configuration for a model, with its key reference. */
  saved(ref: { provider: string; modelId: string; baseUrl?: string | null }): StoredModel | null {
    return this.value.models.find((item) => sameModel(item, ref)) ?? null
  }

  private load(): StoredSettings {
    try {
      if (!existsSync(this.path)) return { ...DEFAULTS }
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredSettings>
      const clean = (item: StoredModel): StoredModel => ({
        ...item,
        provider: (['openai', 'anthropic', 'compatible'] as const).includes(item.provider)
          ? item.provider
          : 'compatible',
        thinking: THINKING.has(item.thinking) ? item.thinking : 'off',
      })
      const model = raw.model ? clean(raw.model) : null
      const models = (Array.isArray(raw.models) ? raw.models : [])
        .filter(
          (item) => item && typeof item.modelId === 'string' && typeof item.keyRef === 'string',
        )
        .map(clean)
      if (model && !models.some((item) => sameModel(item, model))) models.push(model)
      return {
        language: raw.language === 'zh' ? 'zh' : 'en',
        theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
        notify: raw.notify !== false,
        openAtLogin: raw.openAtLogin === true,
        model,
        models,
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
