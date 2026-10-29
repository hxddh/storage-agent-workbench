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
    await providers.save({
      name: 'moto',
      kind: 'aws',
      endpoint: endpoint!,
      region: 'us-east-1',
      forcePathStyle: true,
      auth: 'keys',
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      scope: { buckets: ['c-public-policy', 'c-public-acl', 'c-narrowed', 'c-locked'] },
    })
    deps = {
      db,
      providers,
      taskDir: () => tmpdir(),
      datasetsDir: () => tmpdir(),
      uploadsDir: () => tmpdir(),
      lang: () => 'en',
    }
  })

  /** One `call`, and what came back: the value the window shows and the text the agent got. */
  const call = async (args: Record<string, unknown>) => {
    const result = await callTool(deps).execute(
      args as never,
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
    call({ service: 's3', operation, input: { Bucket } })

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

  it('reads a KMS key policy and CloudTrail events, and never sends the account id', async () => {
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
    expect(JSON.stringify(key.value)).toContain('<account>')
    expect(key.text).not.toContain(account)
    const trail = await call({
      service: 'cloudtrail',
      operation: 'LookupEvents',
      input: {
        LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: 'c-public-policy' }],
      },
    })
    expect(['done', 'failed']).toContain(trail.status)
    expect(trail.text).not.toContain(account)
  })

  it('reads the account-wide block and account-level IAM, without ever sending the id', async () => {
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
    // The agent never has the account id; S3 Control gets it filled in.
    const block = await call({ service: 's3control', operation: 'GetPublicAccessBlock' })
    expect(block.value).toMatchObject({ PublicAccessBlockConfiguration: { BlockPublicAcls: true } })
    expect(block.text).not.toContain(account)
    // An input that names <account> gets the caller's id in its place.
    const caller = await call({ service: 'sts', operation: 'GetCallerIdentity' })
    expect(caller.value).toMatchObject({ Account: '<account>' })
    const iam = await call({ service: 'iam', operation: 'GetAccountAuthorizationDetails' })
    expect(iam.status).toBe('done')
    expect(iam.text).not.toContain(account)
  })
})
