import { describe, expect, it } from 'vitest'
import type { BucketFacts } from './facts'
import { permissionGaps } from './permissions'

function facts(status: string, head: string = 'available'): BucketFacts {
  const dim = { status, value: null }
  return {
    bucket: 'demo',
    region: 'us-east-1',
    aws: true,
    head: head as BucketFacts['head'],
    versioning: dim as BucketFacts['versioning'],
    encryption: dim as BucketFacts['encryption'],
    lifecycle: dim as BucketFacts['lifecycle'],
    replication: dim as BucketFacts['replication'],
    policy: dim as BucketFacts['policy'],
    policyStatus: dim as BucketFacts['policyStatus'],
    pab: dim as BucketFacts['pab'],
    ownership: dim as BucketFacts['ownership'],
    acl: dim as BucketFacts['acl'],
    cors: dim as BucketFacts['cors'],
    logging: dim as BucketFacts['logging'],
    tagging: dim as BucketFacts['tagging'],
    notifications: dim as BucketFacts['notifications'],
    inventory: dim as BucketFacts['inventory'],
    account: { pab: dim as BucketFacts['account']['pab'] },
    capacity: null,
    exposure: { verdict: null, reasons: [] },
  }
}

describe('permission diagnosis', () => {
  it('names the IAM action behind an access-denied read', () => {
    const gaps = permissionGaps(facts('access_denied'))
    expect(gaps.map((gap) => gap.action)).toContain('s3:GetBucketPolicy')
    expect(gaps.map((gap) => gap.action)).toContain('s3:GetEncryptionConfiguration')
  })

  it('does not call a provider capability gap a missing permission', () => {
    expect(permissionGaps(facts('provider_unsupported'))).toEqual([])
  })
})
