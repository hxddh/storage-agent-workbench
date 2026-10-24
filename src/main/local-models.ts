/**
 * Models already running on this machine. Settings offers them so a first run
 * needs no API key. Only loopback is asked, with a short timeout.
 */
export interface LocalModel {
  source: 'Ollama' | 'LM Studio'
  baseUrl: string
  modelId: string
}

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(800) })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}

export async function detectLocalModels(): Promise<LocalModel[]> {
  const found: LocalModel[] = []
  const [ollama, studio] = await Promise.allSettled([
    json('http://127.0.0.1:11434/api/tags'),
    json('http://127.0.0.1:1234/v1/models'),
  ])
  if (ollama.status === 'fulfilled') {
    for (const model of ((ollama.value as { models?: { name?: string }[] }).models ?? []).slice(
      0,
      8,
    ))
      if (model.name)
        found.push({ source: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: model.name })
  }
  if (studio.status === 'fulfilled') {
    for (const model of ((studio.value as { data?: { id?: string }[] }).data ?? []).slice(0, 8))
      if (model.id)
        found.push({ source: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', modelId: model.id })
  }
  return found
}
