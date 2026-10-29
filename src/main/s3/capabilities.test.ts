import { describe, expect, it } from 'vitest'
import { detectProviderKind } from './capabilities'

describe('provider kind', () => {
  it('recognizes common S3-compatible endpoints', () => {
    expect(detectProviderKind('https://abc.r2.cloudflarestorage.com')).toBe('r2')
    expect(detectProviderKind('https://oss-cn-hangzhou.aliyuncs.com')).toBe('aliyun')
    expect(detectProviderKind('http://127.0.0.1:9000')).toBe('minio')
    expect(detectProviderKind('')).toBe('aws')
  })
})
