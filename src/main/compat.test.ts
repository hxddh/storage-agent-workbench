/**
 * Compatibility against an independent AWS emulator (moto), which answers S3,
 * STS and S3 Control the way AWS does. Runs only with
 * STORAGE_AGENT_AWS_ENDPOINT set (the `compat` CI job starts moto_server);
 * our own fake S3 cannot prove we read AWS right.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { Estate } from './estate/estate'
import { emulatorControl, Providers } from './providers'
import type { Vault } from './security/vault'
import { surveyTool } from './tools/survey'

const endpoint = process.env.STORAGE_AGENT_AWS_ENDPOINT
const credentials = { accessKeyId: 'testing', secretAccessKey: 'testing' }

describe.skipIf(!endpoint)('AWS compatibility (moto)', () => {
  const s3 = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials })
  let deps: ConstructorParameters<typeof Estate>[0] extends never
    ? never
    : Parameters<typeof surveyTool>[0]

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
      estate: new Estate(db),
      datasetsDir: () => tmpdir(),
      uploadsDir: () => tmpdir(),
      lang: () => 'en',
    }
  })

  const survey = async () => {
    const result = await surveyTool(deps).execute(
      {} as never,
      { conversationId: 'c', output: () => undefined, details: async () => undefined } as never,
      {} as never,
    )
    const details = result.details as unknown as ToolDetails
    if (details.view?.kind !== 'survey') throw new Error(`expected a survey view: ${details.note}`)
    return details.view
  }

  it('reads exposure the way AWS decides it', async () => {
    const view = await survey()
    const publicOf = new Map(view.buckets.rows.map((row) => [row[0], row[1]]))
    expect(publicOf.get('c-public-policy')).toBe('public')
    expect(publicOf.get('c-public-acl')).toBe('public')
    expect(publicOf.get('c-narrowed')).toBe('no')
    expect(publicOf.get('c-locked')).toBe('no')
  })

  it('reads the account-wide block, and lets it cancel exposure', async () => {
    expect((await survey()).account?.pab).toBe('off')
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
    const view = await survey()
    expect(view.account?.pab).toBe('on')
    expect(view.buckets.rows.every((row) => row[1] === 'no')).toBe(true)
  })
})
