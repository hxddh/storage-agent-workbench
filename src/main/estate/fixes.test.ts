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
