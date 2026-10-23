import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { Vault } from '../security/vault'
import type { StoredModel } from '../settings'

const PROVIDER_ID = 'storage-agent'

/** One Models collection for the whole process; the provider is replaced in place. */
export function createModelSet() {
  return createModels()
}

export function installModel(
  models: ReturnType<typeof createModels>,
  stored: StoredModel,
  vault: Vault,
): { provider: string; modelId: string } {
  const apiKey = vault.open(stored.keyRef)
  const baseUrl =
    stored.provider === 'openai'
      ? stored.baseUrl || 'https://api.openai.com/v1'
      : stored.provider === 'anthropic'
        ? stored.baseUrl || 'https://api.anthropic.com'
        : stored.baseUrl
  if (!baseUrl) throw new Error('A base URL is required for a custom endpoint.')

  const contextWindow = stored.contextWindow > 0 ? stored.contextWindow : 32_768
  const maxTokens = Math.max(1024, Math.min(8192, Math.floor(contextWindow / 4)))

  const common = {
    id: stored.modelId,
    name: stored.modelId,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }

  const auth = {
    apiKey: {
      name: 'API key',
      resolve: async () => ({ auth: { apiKey } }),
    },
  }

  const provider =
    stored.provider === 'anthropic'
      ? createProvider({
          id: PROVIDER_ID,
          name: 'Storage Agent',
          baseUrl,
          auth,
          models: [{ ...common, api: 'anthropic-messages' } as Model<'anthropic-messages'>],
          api: anthropicMessagesApi(),
        })
      : createProvider({
          id: PROVIDER_ID,
          name: 'Storage Agent',
          baseUrl,
          auth,
          models: [{ ...common, api: 'openai-completions' } as Model<'openai-completions'>],
          api: openAICompletionsApi(),
        })

  models.setProvider(provider)
  return { provider: PROVIDER_ID, modelId: stored.modelId }
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
    const response = await models.complete(
      model,
      {
        systemPrompt: 'Answer with one word.',
        messages: [
          { role: 'user', content: 'Reply with the single word: ok', timestamp: Date.now() },
        ],
        tools: [],
      },
      { maxTokens: 16 },
    )
    const text = response.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    return { ok: true, detail: text.trim().slice(0, 80) || 'Connected' }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 240) : String(error),
    }
  }
}
