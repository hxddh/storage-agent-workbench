import { describe, expect, it } from 'vitest'
import type { Posture } from '../s3/posture'
import type { Finding } from '../s3/review'
import { evaluatePosture, evaluateReview, RULES } from './rules'

function posture(overrides: Partial<Posture> = {}): Posture {
  return {
    bucket: 'b',
    region: 'us-east-1',
    head_bucket_status: 'available',
    access_status: 'available',
    versioning_status: 'available',
    versioning_enabled: false,
    encryption_status: 'available',
    lifecycle_status: 'available',
    logging_status: 'available',
    logging_enabled: false,
    replication_status: 'not_configured',
    policy_status: 'not_configured',
    public_access_block_status: 'available',
    policy_public_status: 'not_configured',
    policy_is_public: false,
    ownership_status: 'available',
    object_ownership: 'BucketOwnerEnforced',
    acls_disabled: true,
    acl_status: 'skipped_acls_disabled',
    acl_public: false,
    publicly_exposed: false,
    tagging_status: 'not_configured',
    inventory_status: 'not_configured',
    provider_unsupported_items: [],
    access_denied_items: [],
    error_items: [],
    ...overrides,
  }
}

describe('estate rules', () => {
  it('opens exposure only when the survey proved it', () => {
    expect(evaluatePosture(posture({ publicly_exposed: true })).public_exposure).toBe(true)
    expect(evaluatePosture(posture({ publicly_exposed: false })).public_exposure).toBe(false)
    expect(evaluatePosture(posture({ publicly_exposed: null })).public_exposure).toBeUndefined()
  })

  it('decides missing encryption from the posture flag', () => {
    expect(
      evaluatePosture(posture({ encryption_status: 'not_configured' })).no_default_encryption,
    ).toBe(true)
    expect(evaluatePosture(posture({ encryption_status: 'available' })).no_default_encryption).toBe(
      false,
    )
    expect(
      evaluatePosture(posture({ encryption_status: 'provider_unsupported' })).no_default_encryption,
    ).toBeUndefined()
  })

  it('never resolves a rule from a read that could not see it', () => {
    const findings: Finding[] = [
      { severity: 'medium', title: 'Access denied reading bucket policy', detail: 'denied' },
    ]
    const { verdicts } = evaluateReview('security', findings)
    expect(verdicts.wildcard_principal).toBeUndefined()
    expect(verdicts.cors_all_origins).toBeUndefined()
    expect(verdicts.public_access_block_missing).toBeUndefined()
  })

  it('resolves absent rules when the review was complete', () => {
    const findings: Finding[] = [
      { severity: 'ok', title: 'No bucket policy granting public access', detail: 'none' },
    ]
    const { verdicts } = evaluateReview('security', findings)
    expect(verdicts.wildcard_principal).toBe(false)
    expect(verdicts.cors_all_origins).toBe(false)
    expect(verdicts.no_default_encryption).toBe(false)
  })

  it('marks a present rule and keeps its detail', () => {
    const { verdicts, details } = evaluateReview('lifecycle', [
      {
        severity: 'medium',
        title: 'No AbortIncompleteMultipartUpload rule',
        detail: 'uploads accumulate',
      },
    ])
    expect(verdicts.no_abort_mpu).toBe(true)
    expect(details.no_abort_mpu).toContain('accumulate')
    expect(verdicts.noncurrent_never_expire).toBe(false)
  })

  it('keeps seven stable issue codes', () => {
    expect(RULES).toHaveLength(7)
    expect(new Set(RULES.map((rule) => rule.code)).size).toBe(7)
  })
})
