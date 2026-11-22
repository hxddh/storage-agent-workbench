/**
 * Compatibility against an independent AWS emulator (moto), which answers S3,
 * STS and S3 Control the way AWS does. Runs only with
 * STORAGE_AGENT_AWS_ENDPOINT set (the `compat` CI job starts moto_server);
 * our own fake S3 cannot prove we read AWS right.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateKeyCommand, DescribeKeyCommand, KMSClient } from '@aws-sdk/client-kms'
import {
  CreateBucketCommand,
  PutBucketAclCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { PutPublicAccessBlockCommand as PutAccountBlock } from '@aws-sdk/client-s3-control'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ToolDetails } from '@shared/contract'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyChange, checkChange, inverseOf, snapshotOf } from './changes'
import { AppDb } from './db'
import { emulatorControl, Providers } from './providers'
import type { Vault } from './security/vault'
import { callTool } from './tools/call'
import type { ToolDeps } from './tools/policy'

const endpoint = process.env.STORAGE_AGENT_AWS_ENDPOINT
const credentials = { accessKeyId: 'testing', secretAccessKey: 'testing' }

describe.skipIf(!endpoint)('AWS compatibility (moto)', () => {
  const s3 = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials })
  let deps: ToolDeps

  beforeAll(async () => {
    const policy = (bucket: string, condition?: Record<string, unknown>) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: `arn:aws:s3:::${bucket}/*`,
            ...(condition ? { Condition: condition } : {}),
          },
        ],
      })
    for (const bucket of ['c-public-policy', 'c-public-acl', 'c-narrowed', 'c-locked'])
      await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined)
    await s3.send(
      new PutBucketPolicyCommand({ Bucket: 'c-public-policy', Policy: policy('c-public-policy') }),
    )
    await s3.send(new PutBucketAclCommand({ Bucket: 'c-public-acl', ACL: 'public-read' }))
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: 'c-narrowed',
        Policy: policy('c-narrowed', { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } }),
      }),
    )
    await s3.send(new PutBucketPolicyCommand({ Bucket: 'c-locked', Policy: policy('c-locked') }))
    await s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: 'c-locked',
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
    )

    const db = await AppDb.open(
      await openNodeSqliteDatabase(join(mkdtempSync(join(tmpdir(), 'sa-compat-')), 'db.sqlite')),
    )
    const vault = { seal: (v: string) => v, open: (v: string) => v } as unknown as Vault
    const providers = new Providers(db, vault)
    const scoped = await providers.save({
      name: 'moto',
      endpoint: endpoint!,
      region: 'us-east-1',
      forcePathStyle: true,
      auth: 'keys',
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      scope: { buckets: ['c-public-policy', 'c-public-acl', 'c-narrowed', 'c-locked'] },
    })
    scopedId = scoped.id
    // The same credentials without a scope: account-wide reads run on this one.
    wholeId = (
      await providers.save({
        name: 'moto-whole',
        endpoint: endpoint!,
        region: 'us-east-1',
        forcePathStyle: true,
        auth: 'keys',
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        scope: { buckets: [] },
      })
    ).id
    deps = {
      db,
      providers,
      taskDir: () => tmpdir(),
      datasetsDir: () => tmpdir(),
      userDatasetsDir: tmpdir(),
      uploadsDir: () => tmpdir(),
      lang: () => 'en',
    }
  })

  let scopedId = ''
  let wholeId = ''

  /** One `call`, and what came back: the value the window shows and the text the agent got. */
  const call = async (args: Record<string, unknown>, scoped = false) => {
    const result = await callTool(deps).execute(
      { provider_id: scoped ? scopedId : wholeId, ...args } as never,
      { conversationId: 'c', output: () => undefined, details: async () => undefined } as never,
      {} as never,
    )
    const details = result.details as unknown as ToolDetails
    const text =
      result.output?.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? ''
    return {
      status: details.status,
      value: details.view?.kind === 'raw' ? (details.view.value as Record<string, unknown>) : null,
      text,
    }
  }
  const bucketRead = (operation: string, Bucket: string) =>
    call({ service: 's3', operation, input: { Bucket } }, true)

  it('returns what AWS decides about exposure, as AWS says it', async () => {
    const status = await bucketRead('GetBucketPolicyStatus', 'c-public-policy')
    expect(status.value).toMatchObject({ PolicyStatus: { IsPublic: true } })
    const policy = await bucketRead('GetBucketPolicy', 'c-public-policy')
    expect(JSON.stringify(policy.value)).toContain('"Principal":"*"')
    const acl = await bucketRead('GetBucketAcl', 'c-public-acl')
    expect(JSON.stringify(acl.value)).toContain('AllUsers')
    const narrowed = await bucketRead('GetBucketPolicyStatus', 'c-narrowed')
    expect(narrowed.value).toMatchObject({ PolicyStatus: { IsPublic: false } })
    const locked = await bucketRead('GetPublicAccessBlock', 'c-locked')
    expect(locked.value).toMatchObject({
      PublicAccessBlockConfiguration: { BlockPublicPolicy: true, RestrictPublicBuckets: true },
    })
  })

  it('reads a KMS key policy and CloudTrail events on an unscoped account, refused on a scoped one', async () => {
    const kms = new KMSClient({ region: 'us-east-1', endpoint, credentials })
    const created = await kms.send(new CreateKeyCommand({ Description: 'compat' }))
    const keyId = created.KeyMetadata?.KeyId
    const described = await kms.send(new DescribeKeyCommand({ KeyId: keyId }))
    expect(described.KeyMetadata?.KeyId).toBe(keyId)
    const sts = new STSClient({ region: 'us-east-1', endpoint, credentials })
    const account = (await sts.send(new GetCallerIdentityCommand({}))).Account!
    const key = await call({
      service: 'kms',
      operation: 'GetKeyPolicy',
      input: { KeyId: keyId, PolicyName: 'default' },
    })
    expect(key.status).toBe('done')
    // A scoped account does not reach KMS: it sees beyond its buckets.
    const scopedKey = await call(
      { service: 'kms', operation: 'GetKeyPolicy', input: { KeyId: keyId, PolicyName: 'default' } },
      true,
    )
    expect(scopedKey.status).toBe('refused')
    // The agent reads the account as the service names it.
    expect(JSON.stringify(key.value)).toContain(account)
    const trail = await call({
      service: 'cloudtrail',
      operation: 'LookupEvents',
      input: {
        LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: 'c-public-policy' }],
      },
    })
    expect(['done', 'failed']).toContain(trail.status)
  })

  it('reads the account-wide block and account-level IAM, the id filled in for S3 Control', async () => {
    const sts = new STSClient({ region: 'us-east-1', endpoint, credentials })
    const account = (await sts.send(new GetCallerIdentityCommand({}))).Account!
    const control = emulatorControl({ region: 'us-east-1', credentials }, endpoint!)
    await control.send(
      new PutAccountBlock({
        AccountId: account,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
    )
    // S3 Control needs the id on every call; it is filled in when the agent leaves it out.
    const block = await call({ service: 's3control', operation: 'GetPublicAccessBlock' })
    expect(block.value).toMatchObject({ PublicAccessBlockConfiguration: { BlockPublicAcls: true } })
    const caller = await call({ service: 'sts', operation: 'GetCallerIdentity' })
    expect(caller.value).toMatchObject({ Account: account })
    const iam = await call({ service: 'iam', operation: 'GetAccountAuthorizationDetails' })
    expect(iam.status).toBe('done')
  })

  it('snapshots, applies and rolls back an approved change as S3 answers it', async () => {
    const providers = deps.providers as Providers
    await providers.updateSettings(wholeId, { allowChanges: true })
    const config = await providers.config(wholeId)
    // Moto keeps state between runs: a bucket of its own each time.
    const bucket = `c-change-${Date.now()}`
    await s3.send(new CreateBucketCommand({ Bucket: bucket }))
    const put = {
      service: 's3',
      operation: 'PutPublicAccessBlock',
      input: {
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      },
    }
    checkChange(config, put)
    // Nothing was set: the rollback deletes what the change adds.
    const before = await snapshotOf(providers, config, put)
    expect(before).toBeNull()
    await applyChange(providers, config, put)
    expect(
      (
        await call({
          service: 's3',
          operation: 'GetPublicAccessBlock',
          input: { Bucket: bucket },
        })
      ).value,
    ).toMatchObject({
      PublicAccessBlockConfiguration: { BlockPublicAcls: true },
    })
    const undo = inverseOf(put, before)
    expect(undo.operation).toBe('DeletePublicAccessBlock')
    await applyChange(providers, config, undo)
    expect(
      (
        await call({
          service: 's3',
          operation: 'GetPublicAccessBlock',
          input: { Bucket: bucket },
        })
      ).status,
    ).toBe('failed')
    // A policy: what it replaced is put back as it was.
    const old = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:DeleteBucket',
          Resource: `arn:aws:s3:::${bucket}`,
        },
      ],
    })
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: old }))
    const policy = {
      service: 's3',
      operation: 'PutBucketPolicy',
      input: { Bucket: bucket, Policy: { Version: '2012-10-17', Statement: [] } },
    }
    const snapshot = await snapshotOf(providers, config, policy)
    expect(JSON.parse(String(snapshot?.Policy))).toEqual(JSON.parse(old))
    await applyChange(providers, config, inverseOf(policy, snapshot))
    const restored = await call({
      service: 's3',
      operation: 'GetBucketPolicy',
      input: { Bucket: bucket },
    })
    expect(JSON.stringify(restored.value)).toContain('s3:DeleteBucket')
    // Without the user's permission nothing runs.
    await providers.updateSettings(wholeId, { allowChanges: false })
    await expect(applyChange(providers, await providers.config(wholeId), put)).rejects.toThrow(
      /not allowed/,
    )
  })
})
