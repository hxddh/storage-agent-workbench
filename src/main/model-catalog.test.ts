import { describe, expect, it } from 'vitest'
import { contextFor } from './model-catalog'

describe('model catalog', () => {
  it('knows large windows and narrows matching by prefix', () => {
    expect(contextFor('claude-sonnet-5')).toBe(200_000)
    expect(contextFor('gpt-6-astra-2026-10')).toBe(1_000_000)
  })

  it('returns a conservative window for an unknown model', () => {
    expect(contextFor('tiny-local')).toBe(128_000)
  })
})
