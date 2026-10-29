import { describe, expect, it } from 'vitest'
import { statedMaximum } from './model'

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
