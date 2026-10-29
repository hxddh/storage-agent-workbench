import { createHash } from 'node:crypto'
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { ModelInput, ThinkingLevel } from '@shared/contract'
import { contextFor, thinkingFor } from '../model-catalog'
import type { Vault } from '../security/vault'
import type { StoredModel } from '../settings'

const PROVIDER_ID = 'storage-agent'

/**
 * Each model configuration is its own provider in the shared collection, so a
 * task that runs with another model never replaces the one a concurrent run
 * uses. The id names no secret: the key reference is hashed with the rest.
 */
export function providerIdFor(stored: StoredModel): string {
  const digest = createHash('sha256')
    .update([stored.provider, stored.baseUrl, stored.modelId, stored.keyRef].join('\n'))
    .digest('hex')
    .slice(0, 12)
  return `${PROVIDER_ID}-${digest}`
}

export interface ModelRef {
  provider: string
  modelId: string
}

/** One Models collection for the whole process; one provider per model configuration. */
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
  vault: Vault | null,
  directKey?: string,
  providerId = providerIdFor(stored),
  outputLimit?: number,
): ModelRef {
  const apiKey = directKey ?? vault?.open(stored.keyRef) ?? ''
  const baseUrl = baseUrlOf(stored)
  const contextWindow = stored.contextWindow > 0 ? stored.contextWindow : 128_000
  const reasoning = stored.thinking !== 'off'
  // A bounded default; a provider that accepts more can still be used. The
  // app no longer makes a hidden probe call to discover the limit.
  const maxTokens = outputLimit ?? Math.min(32_000, contextWindow)
  const { api, streams } = apiOf(stored)

  const model = {
    id: stored.modelId,
    name: stored.modelId,
    provider: providerId,
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
      id: providerId,
      name: 'Storage Agent',
      baseUrl,
      auth: { apiKey: { name: 'API key', resolve: async () => ({ auth: { apiKey } }) } },
      models: [model],
      api: streams,
    } as never),
  )
  return { provider: providerId, modelId: stored.modelId }
}

/** pi's thinking level for a stored setting; `off` when the model does not reason. */
export function thinkingOf(stored: StoredModel | null): ThinkingLevel {
  return stored?.thinking ?? 'off'
}

async function testModelWithKey(
  models: ReturnType<typeof createModels>,
  stored: StoredModel,
  apiKey: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    // A test has its own provider id: it never replaces a model a run is using.
    const ref = installModel(models, stored, null, apiKey, `${PROVIDER_ID}-test`)
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

export async function testModel(
  models: ReturnType<typeof createModels>,
  stored: StoredModel,
  vault: Vault,
): Promise<{ ok: boolean; detail: string }> {
  try {
    return await testModelWithKey(models, stored, vault.open(stored.keyRef))
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 240) : String(error),
    }
  }
}

/** Test the values currently in the Settings form without saving them. */
export async function testModelDraft(
  models: ReturnType<typeof createModels>,
  input: ModelInput,
  stored: StoredModel | null,
  vault: Vault,
): Promise<{ ok: boolean; detail: string }> {
  const modelId = input.modelId?.trim()
  if (!modelId) return { ok: false, detail: 'A model id is required.' }
  let apiKey = input.apiKey?.trim() ?? ''
  if (!apiKey && stored?.provider === input.provider) {
    try {
      apiKey = vault.open(stored.keyRef)
    } catch {
      apiKey = ''
    }
  }
  if (!apiKey) return { ok: false, detail: 'Enter an API key first.' }
  const draft: StoredModel = {
    provider: input.provider,
    modelId,
    baseUrl: input.baseUrl?.trim() ?? '',
    contextWindow:
      input.contextWindow && input.contextWindow > 0
        ? Math.min(Math.round(input.contextWindow), 10_000_000)
        : contextFor(modelId),
    thinking: input.thinking ?? thinkingFor(modelId, input.provider),
    keyRef: 'draft',
  }
  return testModelWithKey(models, draft, apiKey)
}
