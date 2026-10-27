import { describe, expect, it } from 'vitest'
import { dict } from './i18n'

describe('localized dictionaries', () => {
  it('keeps the same keys and no empty strings', () => {
    const en = dict('en')
    const zh = dict('zh')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries(zh)) {
      expect(typeof value, key).toBe(typeof en[key as keyof typeof en])
      if (typeof value === 'string') expect(value.trim(), key).not.toBe('')
    }
  })
})
