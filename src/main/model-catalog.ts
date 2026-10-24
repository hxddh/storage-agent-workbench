/**
 * Model setup should be one step: pick a provider, paste a key, choose from the
 * models it reports. Context windows are inferred, never typed by hand.
 */
import type { ModelProvider } from '@shared/contract'

export interface CatalogModel {
  id: string
  contextWindow: number | null
}

/** Known windows; an unknown model falls back to 128k rather than asking. */
const KNOWN: Record<string, number> = {
  'claude-opus-5': 200_000,
  'claude-opus-5-5': 200_000,
  'claude-sonnet-5': 200_000,
  'claude-sonnet-5-5': 200_000,
  'claude-haiku-5-5': 200_000,
  'gpt-6-sol': 400_000,
  'gpt-6-astra': 1_000_000,
  'gpt-6-luna': 200_000,
  'gpt-5.6-sol': 400_000,
  'gpt-5.6-terra': 200_000,
  'gpt-5.6-luna': 200_000,
  'gpt-5.1': 400_000,
  'gpt-5': 400_000,
  o3: 200_000,
  'o4-mini': 200_000,
}

export function contextFor(modelId: string): number {
  const clean = modelId.trim().toLowerCase()
  if (KNOWN[clean]) return KNOWN[clean]
  for (const [name, window] of Object.entries(KNOWN)) if (clean.startsWith(name)) return window
  return 128_000
}

function base(provider: ModelProvider, baseUrl: string): string {
  if (baseUrl.trim()) return baseUrl.trim().replace(/\/+$/, '')
  if (provider === 'openai') return 'https://api.openai.com/v1'
  if (provider === 'anthropic') return 'https://api.anthropic.com'
  throw new Error('A base URL is required for a custom endpoint.')
}

async function json(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200)
    throw new Error(`${response.status} ${text || response.statusText}`)
  }
  return response.json()
}

export async function listModels(input: {
  provider: ModelProvider
  baseUrl: string
  apiKey?: string
}): Promise<{ models: CatalogModel[]; detail: string }> {
  const key = input.apiKey?.trim()
  if (!key && input.provider !== 'compatible')
    throw new Error('Enter an API key first, then fetch the models.')
  const root = base(input.provider, input.baseUrl)
  if (input.provider === 'anthropic') {
    const body = (await json(`${root}/v1/models?limit=100`, {
      headers: { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' },
    })) as { data?: { id?: string }[] }
    return {
      models: (body.data ?? [])
        .filter((item): item is { id: string } => Boolean(item.id))
        .map((item) => ({ id: item.id, contextWindow: contextFor(item.id) })),
      detail: 'Anthropic',
    }
  }
  const body = (await json(`${root}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  })) as { data?: { id?: string }[] }
  return {
    models: (body.data ?? [])
      .filter((item): item is { id: string } => Boolean(item.id))
      .map((item) => ({ id: item.id, contextWindow: contextFor(item.id) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    detail: input.provider === 'openai' ? 'OpenAI' : 'Compatible endpoint',
  }
}
