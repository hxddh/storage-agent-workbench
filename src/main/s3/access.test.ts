import type { IAMClient } from '@aws-sdk/client-iam'
import { describe, expect, it } from 'vitest'
import { evaluateStatements, readAccess } from './access'
import type { BucketFacts } from './facts'
import { evaluatePolicy } from './policy'

function facts(overrides: Partial<Record<keyof BucketFacts, unknown>> = {}): BucketFacts {
  return {
    bucket: 'demo',
    region: 'us-east-1',
    aws: false,
    head: 'available',
    versioning: { status: 'not_configured', value: null },
    encryption: { status: 'not_configured', value: null },
    lifecycle: { status: 'not_configured', value: null },
    replication: { status: 'not_configured', value: null },
    policy: { status: 'not_configured', value: null },
    policyStatus: { status: 'not_configured', value: null },
    pab: {
      status: 'available',
      value: {
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: true,
        restrictPublicBuckets: true,
      },
    },
    ownership: { status: 'not_configured', value: null },
    acl: {
      status: 'available',
      value: { allUsers: false, authenticatedUsers: false, read: false, write: false },
    },
    cors: { status: 'not_configured', value: null },
    logging: { status: 'not_configured', value: null },
    tagging: { status: 'not_configured', value: null },
    notifications: { status: 'not_configured', value: null },
    inventory: { status: 'not_configured', value: null },
    account: { pab: { status: 'not_configured', value: null } },
    capacity: null,
    exposure: { verdict: false, reasons: [] },
    ...overrides,
  } as BucketFacts
}

describe('access', () => {
  it('does not label a policy grant public when public access is blocked', async () => {
    const policy = {
      status: 'available',
      value: {
        statements: [
          {
            principal: '*',
            actions: ['s3:GetObject'],
            condition: null,
            public: true,
          },
        ],
      },
    }
    const access = await readAccess({
      bucket: 'demo',
      facts: facts({ policy }),
      aws: false,
    })
    expect(access.paths[0]).toMatchObject({
      source: 'policy',
      public: false,
      note: 'blocked by public access block',
    })
  })

  it('evaluates identity statements with deny precedence', () => {
    const allow = {
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::demo/*'],
    }
    expect(evaluateStatements([allow], 'demo', 's3:GetObject').allowed).toBe(true)
    expect(
      evaluateStatements(
        [allow, { Effect: 'Deny', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::demo/*'] }],
        'demo',
        's3:GetObject',
      ).allowed,
    ).toBe(false)
  })

  it('pairs object actions with object resources and keeps ARN matching case-sensitive', () => {
    const objectAllow = {
      Effect: 'Allow',
      Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::demo/*',
    }
    const bucketOnly = {
      Effect: 'Allow',
      Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::demo',
    }
    const upperArn = {
      Effect: 'Allow',
      Action: 'S3:GETOBJECT',
      Resource: 'arn:aws:s3:::DEMO/*',
    }
    expect(evaluateStatements([objectAllow], 'demo', 's3:GetObject').allowed).toBe(true)
    expect(evaluateStatements([bucketOnly], 'demo', 's3:GetObject').allowed).toBe(false)
    expect(evaluateStatements([objectAllow], 'demo', 's3:ListBucket').allowed).toBe(false)
    expect(evaluateStatements([upperArn], 'demo', 's3:GetObject').allowed).toBe(false)
  })

  it('applies a bucket-policy Deny to an identity grant', async () => {
    const identity = JSON.stringify({
      Statement: {
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: ['arn:aws:s3:::demo/*'],
      },
    })
    const iam = {
      send: async () => ({
        UserDetailList: [
          {
            UserName: 'reader',
            UserPolicyList: [{ PolicyDocument: identity }],
            AttachedManagedPolicies: [],
          },
        ],
        GroupDetailList: [],
        RoleDetailList: [],
        Policies: [],
        IsTruncated: false,
      }),
    } as unknown as IAMClient
    const access = await readAccess({
      bucket: 'demo',
      facts: facts({
        account: { pab: { status: 'available', value: null }, accountId: '123456789012' },
        policy: {
          status: 'available',
          value: {
            statements: [],
            documents: [
              {
                Effect: 'Deny',
                Principal: '*',
                Action: ['s3:GetObject'],
                Resource: ['arn:aws:s3:::demo/*'],
              },
            ],
          },
        },
      }),
      aws: true,
      iam,
    })
    expect(access.paths.some((item) => item.source === 'iam' && item.principal === 'reader')).toBe(
      false,
    )
  })

  it('marks a policy path as truncated when the display cap is reached', async () => {
    const document = JSON.stringify({
      Statement: Array.from({ length: 21 }, (_, index) => ({
        Sid: `s${index}`,
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: 'arn:aws:s3:::demo/*',
      })),
    })
    const access = await readAccess({
      bucket: 'demo',
      facts: facts({
        policy: { status: 'available', value: evaluatePolicy(document) },
      }),
      aws: false,
    })
    expect(access.coverage.truncated).toBe(true)
  })

  it('does not let a Deny for another principal remove an identity grant', async () => {
    const identity = JSON.stringify({
      Statement: {
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: ['arn:aws:s3:::demo/*'],
      },
    })
    const iam = {
      send: async () => ({
        UserDetailList: [
          {
            UserName: 'reader',
            UserPolicyList: [{ PolicyDocument: identity }],
            AttachedManagedPolicies: [],
          },
        ],
        GroupDetailList: [],
        RoleDetailList: [],
        Policies: [],
        IsTruncated: false,
      }),
    } as unknown as IAMClient
    const access = await readAccess({
      bucket: 'demo',
      facts: facts({
        account: { pab: { status: 'available', value: null }, accountId: '123456789012' },
        policy: {
          status: 'available',
          value: {
            statements: [],
            documents: [
              {
                Effect: 'Deny',
                Principal: { AWS: 'arn:aws:iam::123456789012:role/other' },
                Action: ['s3:GetObject'],
                Resource: ['arn:aws:s3:::demo/*'],
              },
            ],
          },
        },
      }),
      aws: true,
      iam,
    })
    expect(access.paths.some((item) => item.source === 'iam' && item.principal === 'reader')).toBe(
      true,
    )
  })

  it('marks an external resource-policy grant without pretending its identity was read', async () => {
    const access = await readAccess({
      bucket: 'demo',
      facts: facts({
        account: { pab: { status: 'available', value: null }, accountId: '123456789012' },
        policy: {
          status: 'available',
          value: {
            statements: [
              {
                principal: 'AWS:arn:aws:iam::999999999999:root',
                actions: ['s3:GetObject'],
                condition: null,
                public: false,
              },
            ],
            documents: [],
          },
        },
      }),
      aws: false,
    })
    expect(access.paths.find((item) => item.source === 'policy')?.note).toContain(
      'external identity policy not read',
    )
  })

  it('matches an array principal and respects NotPrincipal for a role', () => {
    const allow = {
      Effect: 'Allow',
      Principal: ['arn:aws:iam::123456789012:role/reader'],
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::demo/*'],
    }
    expect(
      evaluateStatements([allow], 'demo', 's3:GetObject', {
        kind: 'role',
        name: 'reader',
        accountId: '123456789012',
      }).allowed,
    ).toBe(true)
    const not = {
      ...allow,
      Principal: undefined,
      NotPrincipal: { AWS: 'arn:aws:iam::123456789012:role/reader' },
    }
    expect(
      evaluateStatements([not], 'demo', 's3:GetObject', {
        kind: 'role',
        name: 'reader',
        accountId: '123456789012',
      }).allowed,
    ).toBe(false)
  })

  it('applies a Deny with NotAction to every action it does not name', () => {
    const allow = {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:ListBucket'],
      Resource: ['arn:aws:s3:::demo', 'arn:aws:s3:::demo/*'],
    }
    const deny = {
      Effect: 'Deny',
      NotAction: ['s3:PutObject'],
      Resource: ['arn:aws:s3:::demo', 'arn:aws:s3:::demo/*'],
    }
    expect(evaluateStatements([allow, deny], 'demo', 's3:GetObject').denied).toBe(true)
    expect(evaluateStatements([allow, deny], 'demo', 's3:PutObject').denied).toBe(false)
  })

  it('treats a conditional deny as undecided, not as an unconditional allow', () => {
    const allow = {
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::demo/*'],
    }
    const conditionalDeny = {
      Effect: 'Deny',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::demo/*'],
      Condition: { IpAddress: { 'aws:SourceIp': ['203.0.113.0/24'] } },
    }
    const result = evaluateStatements([allow, conditionalDeny], 'demo', 's3:GetObject')
    expect(result.allowed).toBe(false)
    expect(result.conditionalDeny).toBe(true)
  })

  it('reads a policy whose Statement is one object, not an array', async () => {
    const document = JSON.stringify({
      Statement: {
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: ['arn:aws:s3:::demo/*'],
      },
    })
    const iam = {
      send: async () => ({
        UserDetailList: [],
        GroupDetailList: [],
        RoleDetailList: [
          {
            RoleName: 'reader',
            RolePolicyList: [{ PolicyDocument: document }],
            AttachedManagedPolicies: [],
          },
        ],
        Policies: [],
        IsTruncated: false,
      }),
    } as unknown as IAMClient
    const access = await readAccess({ bucket: 'demo', facts: facts(), aws: true, iam })
    expect(access.paths.some((item) => item.source === 'iam' && item.principal === 'reader')).toBe(
      true,
    )
  })

  it('counts a missing group membership as undecided, never as clean', async () => {
    const document = JSON.stringify({
      Statement: {
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: ['arn:aws:s3:::demo/*'],
      },
    })
    const iam = {
      send: async () => ({
        UserDetailList: [
          {
            UserName: 'reader',
            GroupList: ['missing-group'],
            UserPolicyList: [{ PolicyDocument: document }],
            AttachedManagedPolicies: [],
          },
        ],
        GroupDetailList: [],
        RoleDetailList: [],
        Policies: [],
        IsTruncated: false,
      }),
    } as unknown as IAMClient
    const access = await readAccess({ bucket: 'demo', facts: facts(), aws: true, iam })
    expect(access.coverage.undecided).toBeGreaterThan(0)
    expect(access.paths.find((item) => item.source === 'iam')?.note).toContain('could not be read')
  })

  it('does not give an ACL write grant a read action', async () => {
    const access = await readAccess({
      bucket: 'demo',
      facts: facts({
        acl: {
          status: 'available',
          value: { allUsers: true, authenticatedUsers: false, read: false, write: true },
        },
      }),
      aws: false,
    })
    expect(access.paths.find((item) => item.source === 'acl')?.actions).toEqual(['write'])
  })

  it('reads account authorization details once for a task-scoped session', async () => {
    let calls = 0
    const iam = {
      send: async () => {
        calls += 1
        return {
          UserDetailList: [],
          GroupDetailList: [],
          RoleDetailList: [],
          Policies: [],
          IsTruncated: false,
        }
      },
    } as unknown as IAMClient
    const session = {}
    const factsFor = () =>
      facts({ account: { pab: { status: 'available', value: null }, accountId: '123456789012' } })
    await readAccess({ bucket: 'demo', facts: factsFor(), aws: true, iam, session })
    await readAccess({ bucket: 'demo', facts: factsFor(), aws: true, iam, session })
    expect(calls).toBe(1)
  })

  it('uses the account-level IgnorePublicAcls for an ACL path', async () => {
    const access = await readAccess({
      bucket: 'demo',
      facts: facts({
        acl: {
          status: 'available',
          value: { allUsers: true, authenticatedUsers: false, read: true, write: false },
        },
        account: {
          pab: {
            status: 'available',
            value: {
              blockPublicAcls: false,
              ignorePublicAcls: true,
              blockPublicPolicy: false,
              restrictPublicBuckets: false,
            },
          },
        },
      }),
      aws: false,
    })
    expect(access.paths.find((item) => item.source === 'acl')).toMatchObject({
      public: false,
      note: 'ignored by public access block',
    })
  })

  it('reports a role trust path only when the role can reach the bucket', async () => {
    const docs = JSON.stringify({
      Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::demo/*'] }],
    })
    const trust = JSON.stringify({
      Statement: [{ Effect: 'Allow', Principal: { AWS: '*' } }],
    })
    const iam = {
      send: async () => ({
        UserDetailList: [],
        GroupDetailList: [],
        RoleDetailList: [
          {
            RoleName: 'reader',
            Arn: 'arn:aws:iam::<account>:role/reader',
            RolePolicyList: [{ PolicyDocument: docs }],
            AttachedManagedPolicies: [],
            AssumeRolePolicyDocument: trust,
            PermissionsBoundary: undefined,
          },
        ],
        Policies: [],
        IsTruncated: false,
      }),
    } as unknown as IAMClient
    const organizations = {
      send: async (command: { constructor: { name: string } }) =>
        command.constructor.name === 'ListParentsCommand' ? { Parents: [] } : { Policies: [] },
    }
    const access = await readAccess({
      bucket: 'demo',
      facts: facts({
        account: { pab: { status: 'available', value: null }, accountId: '123456789012' },
      }),
      aws: true,
      iam,
      organizations: organizations as never,
    })
    expect(access.paths.some((item) => item.source === 'trust')).toBe(true)
    expect(access.paths.find((item) => item.source === 'trust')?.public).toBe(true)
    expect(access.coverage.sources).toContain('SCP')
  })

  it('covers every principal returned by account authorization details', async () => {
    const docs = JSON.stringify({
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: ['arn:aws:s3:::demo/*'],
        },
      ],
    })
    const iam = {
      send: async () => ({
        UserDetailList: [
          {
            UserName: 'reader',
            Arn: 'arn:aws:iam::<account>:user/reader',
            UserPolicyList: [{ PolicyDocument: docs }],
            AttachedManagedPolicies: [],
            GroupList: [],
          },
        ],
        GroupDetailList: [],
        RoleDetailList: [],
        Policies: [],
        IsTruncated: false,
      }),
    } as unknown as IAMClient
    const access = await readAccess({
      bucket: 'demo',
      facts: facts(),
      aws: true,
      iam,
    })
    expect(access.paths.some((item) => item.source === 'iam' && item.principal === 'reader')).toBe(
      true,
    )
    expect(access.coverage).toMatchObject({ principals: 1, evaluated: 1, truncated: false })
  })
})
