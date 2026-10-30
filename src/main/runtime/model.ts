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
  // The model's own output maximum, as its provider stated or accepted it
  // (`learnOutputLimit`), or the context window when it has not said.
  const maxTokens = outputLimit ?? contextWindow
  const { api, streams } = apiOf(stored)

  const model = {
    id: stored.modelId,
    name: stored.modelId,
    provider: providerId,
    baseUrl,
    api,
    reasoning,
    // Anthropic's and OpenAI's own APIs take images; an OpenAI-compatible
    // endpoint may not, and pi tells such a model an image was attached instead.
    input: stored.provider === 'compatible' ? ['text'] : ['text', 'image'],
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
const learned = new Map<string, number>()

/**
 * The most output tokens this model's provider accepts in one reply. Asked
 * once per model per launch with a one-word request: first offering the whole
 * context window; a refusal that names its maximum gives the limit; a refusal
 * about tokens that names none is asked again with half as much, until the
 * provider accepts. Nothing is guessed: the limit is one the provider took.
 */
export async function learnOutputLimit(
  models: ReturnType<typeof createModels>,
  stored: StoredModel,
  vault: Vault | null,
): Promise<number> {
  const key = `${stored.provider}|${baseUrlOf(stored)}|${stored.modelId}`
  const known = learned.get(key)
  if (known) return known
  const window = stored.contextWindow > 0 ? stored.contextWindow : 128_000
  const ask = async (maxTokens: number): Promise<string | null> => {
    try {
      const ref = installModel(models, stored, vault, undefined, `${PROVIDER_ID}-limit`, maxTokens)
      const model = models.getModel(ref.provider, ref.modelId)
      if (!model) return 'no model'
      const response = await models.complete(
        model,
        {
          systemPrompt: 'Answer with one word.',
          messages: [{ role: 'user', content: 'Reply with: ok', timestamp: Date.now() }],
          tools: [],
        },
        { maxTokens },
      )
      return response.stopReason === 'error' ? (response.errorMessage ?? 'error') : null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  let asked = window
  while (asked >= 1) {
    const refusal = await ask(asked)
    if (refusal === null) {
      learned.set(key, asked)
      return asked
    }
    const stated = statedMaximum(refusal, asked)
    if (stated < asked) asked = stated
    else if (/token/i.test(refusal)) asked = Math.floor(asked / 2)
    // Any other error is not about the limit: the run goes ahead and says what failed.
    else return window
  }
  return window
}

/** The maximum a provider's refusal names: the largest number in it below what was asked. */
export function statedMaximum(message: string | undefined, asked: number): number {
  if (!message || !/token/i.test(message)) return asked
  const numbers = (message.replace(/[,_]/g, '').match(/\d{3,}/g) ?? [])
    .map(Number)
    .filter((n) => n > 0 && n < asked)
  return numbers.length ? Math.max(...numbers) : asked
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
