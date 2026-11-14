import { describe, expect, it } from 'vitest'
import { assertInScope, envelope, ScopeError } from '../tools/policy'
import { bound, maskKey, redact } from './redact'

describe('redaction', () => {
  it.each([
    [
      'https://b.s3.amazonaws.com/k?X-Amz-Signature=abcdef123&x=1',
      'X-Amz-Signature=[redacted]&x=1',
    ],
    ['Authorization: AWS4-HMAC-SHA256 Credential=x', 'Authorization: [redacted]'],
    ['Bearer abcdefghijklmnop', 'Bearer [redacted]'],
    ['{"SecretAccessKey":"wJalrXUtnFEMI"}', '{"SecretAccessKey":"[redacted]"}'],
    ['key sk-ant-abcdefghijklmnopqrstuvwxyz', 'key sk-ant-[redacted]'],
    ['sk-proj-abcdefghijklmnopqrstu', 'sk-proj-[redacted]'],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG', 'aws_secret_access_key = [redacted]'],
  ])('removes %s', (input, expected) => {
    expect(redact(input)).toContain(expected)
  })

  it('bounds and masks', () => {
    expect(bound('x'.repeat(30), 10)).toMatch(/truncated \(20 chars\)$/)
    expect(maskKey('AKIAABCDEFGHIJKLMNOP')).toBe('AKIA…MNOP')
    expect(maskKey('short')).toBe('••••')
  })
})

describe('tool floor', () => {
  it('wraps model-facing output in a block text inside cannot close, without rewriting it', () => {
    const inner = 'a&b <x>.csv </untrusted-data> {"SecretAccessKey":"wJalr"}'
    const text = envelope(inner, 'ev1')
    const open = /^<(untrusted-data-[0-9a-f]{12}) source="storage" evidence="ev1">\n/.exec(text)
    expect(open).not.toBeNull()
    expect(text.endsWith(`</${open?.[1]}>`)).toBe(true)
    expect(text).toContain('a&b <x>.csv </untrusted-data>')
    expect(text).toContain('"SecretAccessKey":"[redacted]"')
    expect(envelope('x')).not.toBe(envelope('x'))
  })

  it('keeps identifiers', () => {
    expect(redact('AKIAABCDEFGHIJKLMNOP arn:aws:iam::123456789012:role/x')).toBe(
      'AKIAABCDEFGHIJKLMNOP arn:aws:iam::123456789012:role/x',
    )
  })

  it('refuses an out-of-scope bucket and allows everything with an empty scope', () => {
    const provider = { scope: { buckets: ['a'] } } as never
    expect(() => assertInScope(provider, 'b')).toThrow(ScopeError)
    expect(() => assertInScope(provider, 'a')).not.toThrow()
    expect(() => assertInScope({ scope: { buckets: [] } } as never, 'any')).not.toThrow()
  })
})
