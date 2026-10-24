import { describe, expect, it } from 'vitest'
import { capabilitiesOf, detectProviderKind } from './capabilities'

describe('provider capabilities', () => {
  it('recognizes common S3-compatible endpoints', () => {
    expect(detectProviderKind('https://abc.r2.cloudflarestorage.com')).toBe('r2')
    expect(detectProviderKind('https://oss-cn-hangzhou.aliyuncs.com')).toBe('aliyun')
    expect(detectProviderKind('http://127.0.0.1:9000')).toBe('minio')
    expect(detectProviderKind('')).toBe('aws')
  })

  it('keeps AWS-only reads out of R2', () => {
    expect(capabilitiesOf('r2')).toMatchObject({
      iam: false,
      kms: false,
      cloudTrail: false,
      inventory: false,
      acl: 'none',
    })
    expect(capabilitiesOf('aws')).toMatchObject({ iam: true, accessAnalyzer: true })
  })
})
