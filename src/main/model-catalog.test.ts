import { describe, expect, it } from 'vitest'
import { contextFor, thinkingFor } from './model-catalog'

describe('model catalog', () => {
  it('knows large windows and narrows matching by prefix', () => {
    expect(contextFor('claude-sonnet-5')).toBe(200_000)
    expect(contextFor('gpt-6-astra-2026-10')).toBe(1_000_000)
  })

  it('returns a conservative window for an unknown model', () => {
    expect(contextFor('tiny-local')).toBe(128_000)
  })

  it('only enables thinking for models known to support it', () => {
    expect(thinkingFor('gpt-6-astra', 'openai')).toBe('medium')
    expect(thinkingFor('claude-sonnet-5', 'anthropic')).toBe('medium')
    expect(thinkingFor('tiny-local', 'compatible')).toBe('off')
  })
})
