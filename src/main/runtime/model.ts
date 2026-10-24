import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { ThinkingLevel } from '@shared/contract'
import type { Vault } from '../security/vault'
import type { StoredModel } from '../settings'

const PROVIDER_ID = 'storage-agent'

export interface ModelRef {
  provider: string
  modelId: string
}

/** One Models collection for the whole process; the provider is replaced in place. */
export function createModelSet() {
  return createModels()
}

/**
 * The API each provider speaks. OpenAI uses the Responses API, which carries
 * reasoning models and their effort; any other OpenAI-compatible endpoint
 * (Ollama, LM Studio, vLLM, OpenRouter) uses Chat Completions.
 */
function apiOf(stored: StoredModel) {
  if (stored.provider === 'anthropic')
    return { api: 'anthropic-messages' as const, streams: anthropicMessagesApi() }
  if (stored.provider === 'openai')
    return { api: 'openai-responses' as const, streams: openAIResponsesApi() }
  return { api: 'openai-completions' as const, streams: openAICompletionsApi() }
}

function baseUrlOf(stored: StoredModel): string {
  if (stored.baseUrl) return stored.baseUrl
  if (stored.provider === 'openai') return 'https://api.openai.com/v1'
  if (stored.provider === 'anthropic') return 'https://api.anthropic.com'
  throw new Error('A base URL is required for a custom endpoint.')
}

export function installModel(
  models: ReturnType<typeof createModels>,
  stored: StoredModel,
  vault: Vault,
): ModelRef {
  const apiKey = vault.open(stored.keyRef)
  const baseUrl = baseUrlOf(stored)
  const contextWindow = stored.contextWindow > 0 ? stored.contextWindow : 128_000
  const reasoning = stored.thinking !== 'off'
  // The verdict is two sentences; the budget is for tool calls and, when on, thinking.
  const maxTokens = Math.max(
    4096,
    Math.min(reasoning ? 32_000 : 8192, Math.floor(contextWindow / 4)),
  )
  const { api, streams } = apiOf(stored)

  const model = {
    id: stored.modelId,
    name: stored.modelId,
    provider: PROVIDER_ID,
    baseUrl,
    api,
    reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  } as unknown as Model<typeof api>

  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: 'Storage Agent',
      baseUrl,
      auth: { apiKey: { name: 'API key', resolve: async () => ({ auth: { apiKey } }) } },
      models: [model],
      api: streams,
    } as never),
  )
  return { provider: PROVIDER_ID, modelId: stored.modelId }
}

/** pi's thinking level for a stored setting; `off` when the model does not reason. */
export function thinkingOf(stored: StoredModel | null): ThinkingLevel {
  return stored?.thinking ?? 'off'
}

export async function testModel(
  models: ReturnType<typeof createModels>,
  stored: StoredModel,
  vault: Vault,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const ref = installModel(models, stored, vault)
    const model = models.getModel(ref.provider, ref.modelId)
    if (!model) return { ok: false, detail: 'The model is not available.' }
    const started = Date.now()
    const response = await models.complete(
      model,
      {
        systemPrompt: 'Answer with one word.',
        messages: [
          { role: 'user', content: 'Reply with the single word: ok', timestamp: Date.now() },
        ],
        tools: [],
      },
      { maxTokens: stored.thinking === 'off' ? 16 : 2048 },
    )
    if (response.stopReason === 'error')
      return {
        ok: false,
        detail: (response.errorMessage ?? 'The model returned an error.').slice(0, 240),
      }
    const text = response.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    return {
      ok: true,
      detail: `${text.trim().slice(0, 40) || 'Connected'} · ${Date.now() - started} ms`,
    }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 240) : String(error),
    }
  }
}
