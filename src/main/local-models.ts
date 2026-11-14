/**
 * Models already running on this machine. Settings offers them so a first run
 * needs no API key. Only loopback is asked, with a short timeout.
 *
 * Each comes with the context window it will actually run with. A local
 * server truncates a longer prompt silently — the system prompt first — so a
 * guess that is too large is worse than one too small: Ollama's and LM
 * Studio's own default (4096 tokens) is assumed unless the server says the
 * model is loaded with more.
 */
export interface LocalModel {
  source: 'Ollama' | 'LM Studio'
  baseUrl: string
  modelId: string
  /** The window the server runs the model with, in tokens. */
  contextWindow: number
}

/** What both servers load a model with unless told otherwise. */
export const LOCAL_DEFAULT_CONTEXT = 4096

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(800) })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

export async function detectLocalModels(): Promise<LocalModel[]> {
  const found: LocalModel[] = []
  const [ollama, ollamaLoaded, studio, studioDetail] = await Promise.allSettled([
    json('http://127.0.0.1:11434/api/tags'),
    json('http://127.0.0.1:11434/api/ps'),
    json('http://127.0.0.1:1234/v1/models'),
    json('http://127.0.0.1:1234/api/v0/models'),
  ])
  if (ollama.status === 'fulfilled') {
    // A loaded model reports the window it runs with.
    const loaded = new Map<string, number>()
    if (ollamaLoaded.status === 'fulfilled')
      for (const item of (ollamaLoaded.value as { models?: Record<string, unknown>[] }).models ??
        []) {
        const size = positive(item.context_length)
        if (typeof item.name === 'string' && size) loaded.set(item.name, size)
      }
    for (const model of ((ollama.value as { models?: { name?: string }[] }).models ?? []).slice(
      0,
      8,
    ))
      if (model.name)
        found.push({
          source: 'Ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelId: model.name,
          contextWindow: loaded.get(model.name) ?? LOCAL_DEFAULT_CONTEXT,
        })
  }
  if (studio.status === 'fulfilled') {
    const detail = new Map<string, number>()
    if (studioDetail.status === 'fulfilled')
      for (const item of (studioDetail.value as { data?: Record<string, unknown>[] }).data ?? []) {
        const size = positive(item.loaded_context_length)
        if (typeof item.id === 'string' && size) detail.set(item.id, size)
      }
    for (const model of ((studio.value as { data?: { id?: string }[] }).data ?? []).slice(0, 8))
      if (model.id)
        found.push({
          source: 'LM Studio',
          baseUrl: 'http://127.0.0.1:1234/v1',
          modelId: model.id,
          contextWindow: detail.get(model.id) ?? LOCAL_DEFAULT_CONTEXT,
        })
  }
  return found
}

/** Whether a base URL is a server on this machine, which needs no key. */
export function isLoopback(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}
