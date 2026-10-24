import { describe, expect, it } from 'vitest'
import { generateFix, impactPreview } from './fixes'
import { BY_CODE } from './rules'

describe('generated fixes', () => {
  it('produces CLI, Terraform and API formats', () => {
    const fix = generateFix(BY_CODE.get('public_exposure')!, 'logs-prod', null, 'eu-west-1')
    expect(fix?.formats.map((format) => format.label)).toEqual([
      'AWS CLI',
      'Terraform',
      'API document',
    ])
    expect(fix?.formats[0]?.text).toContain("--region 'eu-west-1'")
    expect(fix?.formats[0]?.text).toContain('put-public-access-block')
    expect(fix?.formats[1]?.text).toContain('aws_s3_bucket_public_access_block')
  })

  it('points the command at a custom endpoint', () => {
    const fix = generateFix(
      BY_CODE.get('no_default_encryption')!,
      'bucket-a',
      'https://minio.example:9000',
      'us-east-1',
    )
    expect(fix?.formats[0]?.text).toContain("--endpoint-url 'https://minio.example:9000'")
    expect(fix?.notes[0]).toContain('minio.example')
  })

  it('refuses a bucket name no shell can quote safely', () => {
    expect(generateFix(BY_CODE.get('public_exposure')!, 'x; rm -rf ~', null, null)).toBeNull()
    expect(
      generateFix(BY_CODE.get('public_exposure')!, 'ok.bucket-name_1', null, null),
    ).not.toBeNull()
  })

  it('says it cannot tell when no posture was recorded', () => {
    const impact = impactPreview(BY_CODE.get('public_exposure')!, null, false)
    expect(impact.verdict).toBe('unknown')
    expect(impact.gap).toBeTruthy()
  })

  it('warns that a lifecycle put replaces existing rules', () => {
    const impact = impactPreview(
      BY_CODE.get('no_abort_mpu')!,
      { lifecycle_status: 'available' },
      true,
    )
    expect(impact.verdict).toBe('caution')
    expect(impact.reasons.join(' ')).toContain('replaces')
  })
})

describe('fixes for the 19.0 rules', () => {
  const fix = (code: string, bucket = 'demo') =>
    generateFix(BY_CODE.get(code)!, bucket, null, 'us-east-1')

  it('asks for the account id instead of storing it', () => {
    const out = fix('account_public_access_block_missing', '')
    expect(out?.formats[0]?.text).toContain(
      "aws --region 'us-east-1' s3control put-public-access-block --account-id <account-id>",
    )
    expect(out?.formats.find((f) => f.label === 'Terraform')?.text).toContain(
      'aws_s3_account_public_access_block',
    )
  })

  it('denies plain HTTP with a statement to merge', () => {
    const out = fix('insecure_transport')
    expect(out?.formats.find((f) => f.label === 'API document')?.text).toContain(
      'aws:SecureTransport',
    )
    expect(out?.notes.join(' ')).toMatch(/REPLACES the bucket policy/)
  })

  it('turns ACLs off and leaves the log bucket to the user', () => {
    expect(fix('acls_enabled')?.formats[0]?.text).toContain('BucketOwnerEnforced')
    expect(fix('access_logging_off')?.formats[0]?.text).toContain('<log-bucket>')
  })

  it('moves a large Standard bucket to Intelligent-Tiering', () => {
    const out = fix('large_standard_only')
    expect(out?.formats.find((f) => f.label === 'Terraform')?.text).toContain(
      'storage_class = "INTELLIGENT_TIERING"',
    )
  })

  it('never generates a bucket fix for an empty bucket name', () => {
    expect(fix('acls_enabled', '')).toBeNull()
  })
})
