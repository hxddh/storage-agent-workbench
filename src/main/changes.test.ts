import { describe, expect, it } from 'vitest'
import { CHANGE_OPERATIONS, checkChange, inverseOf, normaliseInput } from './changes'
import type { ProviderConfig } from './providers'

const config = (buckets: string[] = []) =>
  ({ id: 'p', name: 'Prod', scope: { buckets }, allowChanges: true }) as unknown as ProviderConfig

describe('approved changes', () => {
  it('allows only reversible bucket configuration', () => {
    expect(CHANGE_OPERATIONS).toContain('s3:PutPublicAccessBlock')
    for (const [service, operation] of [
      ['s3', 'PutObject'],
      ['s3', 'DeleteObject'],
      ['s3', 'DeleteBucket'],
      ['iam', 'CreateAccessKey'],
      ['s3', 'GetBucketPolicy'],
    ] as const)
      expect(() => checkChange(config(), { service, operation, input: { Bucket: 'b' } })).toThrow(
        /not a change this app makes/,
      )
  })

  it('checks input members and the scope like a read', () => {
    expect(() =>
      checkChange(config(), {
        service: 's3',
        operation: 'PutBucketPolicy',
        input: { Bucket: 'b', Policy: '{}', Polcy: 'x' },
      }),
    ).toThrow(/no input member Polcy/)
    expect(() =>
      checkChange(config(['logs']), {
        service: 's3',
        operation: 'PutPublicAccessBlock',
        input: { Bucket: 'web-assets', PublicAccessBlockConfiguration: {} },
      }),
    ).toThrow(/scoped to logs/)
    // An account-wide write reaches beyond any scope.
    expect(() =>
      checkChange(config(['logs']), {
        service: 's3control',
        operation: 'PutPublicAccessBlock',
        input: { PublicAccessBlockConfiguration: {} },
      }),
    ).toThrow(/scoped to logs/)
    expect(() =>
      checkChange(config(['logs']), {
        service: 's3',
        operation: 'PutPublicAccessBlock',
        input: { Bucket: 'logs', PublicAccessBlockConfiguration: { BlockPublicAcls: true } },
      }),
    ).not.toThrow()
  })

  it('puts back what a change replaced, or deletes what did not exist', () => {
    const put = {
      service: 's3',
      operation: 'PutBucketPolicy',
      input: { Bucket: 'b', Policy: '{"new":1}' },
    }
    expect(inverseOf(put, { Policy: '{"old":1}' })).toEqual({
      service: 's3',
      operation: 'PutBucketPolicy',
      input: { Bucket: 'b', Policy: '{"old":1}' },
    })
    expect(inverseOf(put, null)).toEqual({
      service: 's3',
      operation: 'DeleteBucketPolicy',
      input: { Bucket: 'b' },
    })
    const block = {
      service: 's3',
      operation: 'PutPublicAccessBlock',
      input: { Bucket: 'b', PublicAccessBlockConfiguration: { BlockPublicAcls: true } },
    }
    expect(inverseOf(block, null).operation).toBe('DeletePublicAccessBlock')
    // The inverse of a change is itself checked, deletes allowed only as inverses.
    expect(() => checkChange(config(), inverseOf(put, null), true)).not.toThrow()
    expect(() =>
      checkChange(config(), {
        service: 's3',
        operation: 'DeleteBucketEncryption',
        input: { Bucket: 'b' },
      }),
    ).toThrow(/not a change/)
  })

  it('takes a policy as an object and sends it as JSON text', () => {
    expect(normaliseInput({ Bucket: 'b', Policy: { Version: '2012-10-17' } })).toEqual({
      Bucket: 'b',
      Policy: '{"Version":"2012-10-17"}',
    })
  })
})
