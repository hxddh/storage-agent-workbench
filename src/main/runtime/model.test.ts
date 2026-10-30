import { describe, expect, it } from 'vitest'
import { learnOutputLimit, statedMaximum } from './model'

describe("the model's output limit", () => {
  it("takes the maximum a provider's refusal names", () => {
    expect(
      statedMaximum(
        'max_tokens: 200000 > 64000, which is the maximum allowed number of output tokens',
        200_000,
      ),
    ).toBe(64_000)
    expect(
      statedMaximum(
        'max_tokens is too large: 400000. This model supports at most 128,000 completion tokens.',
        400_000,
      ),
    ).toBe(128_000)
  })

  it('keeps what it asked for when the error is not about tokens', () => {
    expect(statedMaximum('Invalid API key', 200_000)).toBe(200_000)
    expect(statedMaximum(undefined, 200_000)).toBe(200_000)
  })
})

describe('learning the limit', () => {
  /** A provider that takes at most `limit` output tokens; `named` says the number when it refuses. */
  function provider(limit: number, named: boolean) {
    const asked: number[] = []
    const models = {
      setProvider: () => undefined,
      getModel: () => ({ id: 'm' }),
      complete: async (_model: unknown, _context: unknown, options: { maxTokens: number }) => {
        asked.push(options.maxTokens)
        if (options.maxTokens <= limit) return { stopReason: 'stop' }
        return {
          stopReason: 'error',
          errorMessage: named
            ? `max_tokens ${options.maxTokens} > ${limit}, the maximum output tokens`
            : 'max_tokens is too large for this model',
        }
      },
    }
    return { models: models as never, asked }
  }
  const stored = (modelId: string) =>
    ({
      provider: 'compatible',
      modelId,
      baseUrl: 'http://127.0.0.1:1',
      contextWindow: 200_000,
      thinking: 'off',
      keyRef: '',
    }) as never

  it('takes a named maximum at once', async () => {
    const { models, asked } = provider(64_000, true)
    expect(await learnOutputLimit(models, stored('named'), null)).toBe(64_000)
    expect(asked).toEqual([200_000, 64_000])
  })

  it('halves until the provider accepts when the refusal names no number', async () => {
    const { models, asked } = provider(30_000, false)
    expect(await learnOutputLimit(models, stored('unnamed'), null)).toBe(25_000)
    expect(asked).toEqual([200_000, 100_000, 50_000, 25_000])
  })
})
