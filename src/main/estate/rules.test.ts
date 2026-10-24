import { describe, expect, it } from 'vitest'
import { type BucketFacts, exposureOf } from '../s3/facts'
import { evaluatePolicy } from '../s3/policy'
import { decide, RULES, reviewFindings, undecidedRules } from './rules'

const PRIVATE_PAB = {
  blockPublicAcls: true,
  ignorePublicAcls: true,
  blockPublicPolicy: true,
  restrictPublicBuckets: true,
}

function facts(overrides: Partial<BucketFacts> = {}): BucketFacts {
  const base: BucketFacts = {
    bucket: 'b',
    region: 'us-east-1',
    head: 'available',
    versioning: { status: 'available', value: { enabled: false, suspended: false } },
    encryption: { status: 'available', value: { algorithm: 'AES256' } },
    lifecycle: {
      status: 'available',
      value: {
        rules: 1,
        abortMpu: true,
        expiration: true,
        transition: true,
        noncurrentExpiration: true,
      },
    },
    replication: { status: 'not_configured', value: null },
    policy: { status: 'not_configured', value: null },
    policyStatus: { status: 'not_configured', value: null },
    pab: { status: 'available', value: PRIVATE_PAB },
    ownership: { status: 'available', value: { mode: 'BucketOwnerEnforced' } },
    acl: { status: 'skipped_acls_disabled', value: null },
    cors: { status: 'not_configured', value: null },
    logging: { status: 'unread', value: null },
    tagging: { status: 'unread', value: null },
    notifications: { status: 'unread', value: null },
    inventory: { status: 'unread', value: null },
    exposure: { verdict: null, reasons: [] },
    ...overrides,
  }
  base.exposure = exposureOf(base)
  return base
}

const policy = (statement: Record<string, unknown>) =>
  JSON.stringify({ Version: '2012-10-17', Statement: [statement] })

describe('policy evaluation', () => {
  it('reads anonymous access through action wildcards', () => {
    const facts = evaluatePolicy(
      policy({ Effect: 'Allow', Principal: '*', Action: 's3:Get*', Resource: 'arn:aws:s3:::b/*' }),
    )
    expect(facts).toMatchObject({ wildcardPrincipal: true, publicRead: true, publicList: false })
  })

  it('treats {"AWS":"*"} and NotPrincipal as everyone', () => {
    expect(
      evaluatePolicy(
        policy({ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: 's3:ListBucket' }),
      ).publicList,
    ).toBe(true)
    expect(
      evaluatePolicy(policy({ Effect: 'Allow', NotPrincipal: { AWS: 'arn:x' }, Action: 's3:*' }))
        .publicWrite,
    ).toBe(true)
  })

  it('does not call a condition-narrowed statement public', () => {
    const facts = evaluatePolicy(
      policy({
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } },
      }),
    )
    expect(facts).toMatchObject({ wildcardPrincipal: true, conditional: true, publicRead: false })
  })

  it('keeps a non-restricting condition public', () => {
    const facts = evaluatePolicy(
      policy({
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Condition: { Bool: { 'aws:SecureTransport': 'true' } },
      }),
    )
    expect(facts.publicRead).toBe(true)
  })

  it('reports an unparseable document instead of clearing it', () => {
    expect(evaluatePolicy('{not json').unreadable).toBe(true)
  })
})

describe('exposure', () => {
  it('proves exposure from the local policy when the provider has no policy status', () => {
    const f = facts({
      policyStatus: { status: 'provider_unsupported', value: null },
      policy: {
        status: 'available',
        value: evaluatePolicy(policy({ Effect: 'Allow', Principal: '*', Action: 's3:GetObject' })),
      },
      pab: { status: 'provider_unsupported', value: null },
    })
    expect(f.exposure.verdict).toBe(true)
  })

  it('lets RestrictPublicBuckets and IgnorePublicAcls block exposure', () => {
    const f = facts({
      policyStatus: { status: 'available', value: { isPublic: true } },
      policy: {
        status: 'available',
        value: evaluatePolicy(policy({ Effect: 'Allow', Principal: '*', Action: '*' })),
      },
      ownership: { status: 'available', value: { mode: 'ObjectWriter' } },
      acl: {
        status: 'available',
        value: { allUsers: true, authenticatedUsers: false, write: false },
      },
    })
    expect(f.exposure.verdict).toBe(false)
  })

  it('leaves exposure open when the ACL is unreadable', () => {
    const f = facts({
      ownership: { status: 'available', value: { mode: 'ObjectWriter' } },
      acl: { status: 'access_denied', value: null },
    })
    expect(f.exposure.verdict).toBeNull()
    expect(decide(f).public_exposure).toBeUndefined()
  })
})

describe('rules', () => {
  it('has seven rules', () => {
    expect(RULES.map((rule) => rule.code)).toHaveLength(7)
  })

  it('decides every rule on a fully readable private bucket, all clean', () => {
    const decisions = decide(facts())
    expect(Object.keys(decisions).sort()).toEqual(RULES.map((rule) => rule.code).sort())
    expect(Object.values(decisions).every((d) => d.verdict === false)).toBe(true)
  })

  it('never resolves lifecycle rules from an unconfigured lifecycle', () => {
    const f = facts({
      versioning: { status: 'available', value: { enabled: true, suspended: false } },
      lifecycle: { status: 'not_configured', value: null },
    })
    expect(decide(f).no_abort_mpu?.verdict).toBe(true)
    expect(decide(f).noncurrent_never_expire?.verdict).toBe(true)
  })

  it('names the switches a partial public access block leaves off', () => {
    const f = facts({
      pab: { status: 'available', value: { ...PRIVATE_PAB, restrictPublicBuckets: false } },
    })
    expect(decide(f).public_access_block_missing).toEqual({
      verdict: true,
      detail: 'Off: RestrictPublicBuckets',
    })
  })

  it('never decides a rule from a read that could not see it', () => {
    const f = facts({
      encryption: { status: 'access_denied', value: null },
      cors: { status: 'provider_unsupported', value: null },
    })
    expect(decide(f).no_default_encryption).toBeUndefined()
    expect(decide(f).cors_all_origins).toBeUndefined()
    expect(
      undecidedRules(f)
        .map((item) => item.code)
        .sort(),
    ).toEqual(['cors_all_origins', 'no_default_encryption'])
  })

  it('reports blind spots in a review, never as clean', () => {
    const f = facts({ cors: { status: 'provider_unsupported', value: null } })
    const { findings } = reviewFindings(f, 'security', 'en')
    expect(findings.find((x) => x.severity === 'blind')?.title).toBe(
      'Not supported by the provider: CORS',
    )
  })

  it('words its evidence in the user language', () => {
    const f = facts({
      pab: { status: 'available', value: { ...PRIVATE_PAB, blockPublicAcls: false } },
    })
    expect(decide(f, 'zh').public_access_block_missing?.detail).toBe('未开启：BlockPublicAcls')
  })
})
