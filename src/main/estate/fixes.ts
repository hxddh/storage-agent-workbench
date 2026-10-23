import type { FixFormat, Impact } from '@shared/contract'
import type { Rule } from './rules'

const SAFE_BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/

const PAB = {
  BlockPublicAcls: true,
  IgnorePublicAcls: true,
  BlockPublicPolicy: true,
  RestrictPublicBuckets: true,
}

const SSE = {
  Rules: [
    {
      ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
      BucketKeyEnabled: true,
    },
  ],
}

function lifecycle(body: Record<string, unknown>, id: string): Record<string, unknown> {
  return { Rules: [{ ID: id, Status: 'Enabled', Filter: {}, ...body }] }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function jsonArg(value: unknown): string {
  return quote(JSON.stringify(value, null, 0))
}

function tfString(value: string): string {
  return JSON.stringify(value).replace(/\$\{/g, '$${').replace(/%\{/g, '%%{')
}

function tfName(bucket: string): string {
  const name = bucket.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60) || 'bucket'
  return /^[A-Za-z_]/.test(name) ? name : `b_${name}`
}

interface Fix {
  kind: 'public_access_block' | 'default_encryption' | 'lifecycle'
  document: Record<string, unknown>
  command: string
  notes: string[]
}

function build(code: string, bucket: string): Fix | null {
  const b = quote(bucket)
  if (code === 'public_exposure' || code === 'public_access_block_missing') {
    return {
      kind: 'public_access_block',
      document: PAB,
      command: `aws s3api put-public-access-block --bucket ${b} --public-access-block-configuration ${jsonArg(PAB)}`,
      notes: [
        'Blocks public ACLs and public policies for this bucket.',
        'If the bucket serves a website or public downloads on purpose, put a CDN with origin access in front of it first.',
        ...(code === 'public_exposure'
          ? ['Also review the policy and ACL grants that made it public.']
          : []),
      ],
    }
  }
  if (code === 'no_default_encryption') {
    return {
      kind: 'default_encryption',
      document: SSE,
      command: `aws s3api put-bucket-encryption --bucket ${b} --server-side-encryption-configuration ${jsonArg(SSE)}`,
      notes: [
        'Applies SSE-S3 (AES256) to new objects; existing objects are unchanged.',
        'Use aws:kms with your own key instead if policy requires KMS.',
      ],
    }
  }
  if (code === 'no_abort_mpu') {
    const doc = lifecycle(
      { AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
      'abort-incomplete-mpu-7d',
    )
    return {
      kind: 'lifecycle',
      document: doc,
      command: `aws s3api put-bucket-lifecycle-configuration --bucket ${b} --lifecycle-configuration ${jsonArg(doc)}`,
      notes: [
        "This call REPLACES the bucket's lifecycle configuration: merge this rule into existing rules first.",
      ],
    }
  }
  if (code === 'noncurrent_never_expire') {
    const doc = lifecycle(
      { NoncurrentVersionExpiration: { NoncurrentDays: 30 } },
      'expire-noncurrent-30d',
    )
    return {
      kind: 'lifecycle',
      document: doc,
      command: `aws s3api put-bucket-lifecycle-configuration --bucket ${b} --lifecycle-configuration ${jsonArg(doc)}`,
      notes: [
        'Noncurrent versions older than 30 days are deleted — choose the retention your recovery policy needs.',
        "This call REPLACES the bucket's lifecycle configuration: merge this rule into existing rules first.",
      ],
    }
  }
  return null
}

function terraform(
  fix: Fix,
  bucket: string,
  endpoint: string | null,
  region: string | null,
): string | null {
  const name = tfName(bucket)
  const b = tfString(bucket)
  let body: string
  if (fix.kind === 'public_access_block') {
    body =
      `resource "aws_s3_bucket_public_access_block" "${name}" {\n  bucket = ${b}\n\n` +
      '  block_public_acls       = true\n  ignore_public_acls      = true\n' +
      '  block_public_policy     = true\n  restrict_public_buckets = true\n}'
  } else if (fix.kind === 'default_encryption') {
    body =
      `resource "aws_s3_bucket_server_side_encryption_configuration" "${name}" {\n  bucket = ${b}\n\n` +
      '  rule {\n    apply_server_side_encryption_by_default {\n      sse_algorithm = "AES256"\n    }\n' +
      '    bucket_key_enabled = true\n  }\n}'
  } else {
    const rules = (fix.document.Rules as Record<string, unknown>[]) ?? []
    const rendered = rules.map((rule) => {
      const lines = [
        `    id     = ${tfString(String(rule.ID ?? 'rule'))}`,
        '    status = "Enabled"',
        '    filter {}',
      ]
      const abort = rule.AbortIncompleteMultipartUpload as
        | { DaysAfterInitiation?: number }
        | undefined
      if (abort) {
        lines.push(
          `    abort_incomplete_multipart_upload {\n      days_after_initiation = ${abort.DaysAfterInitiation ?? 7}\n    }`,
        )
      }
      const noncurrent = rule.NoncurrentVersionExpiration as { NoncurrentDays?: number } | undefined
      if (noncurrent) {
        lines.push(
          `    noncurrent_version_expiration {\n      noncurrent_days = ${noncurrent.NoncurrentDays ?? 30}\n    }`,
        )
      }
      return `  rule {\n${lines.join('\n')}\n  }`
    })
    body = `resource "aws_s3_bucket_lifecycle_configuration" "${name}" {\n  bucket = ${b}\n\n${rendered.join('\n\n')}\n}`
  }
  if (!endpoint) return body
  const head = [
    '# This bucket lives on a custom S3 endpoint; your aws provider needs:',
    `#   endpoints { s3 = ${tfString(endpoint)} }`,
    '#   s3_use_path_style = true',
  ]
  if (region) head.push(`#   region = ${tfString(region)}`)
  return `${head.join('\n')}\n\n${body}`
}

export interface GeneratedFix {
  formats: FixFormat[]
  notes: string[]
}

export function generateFix(
  rule: Rule,
  bucket: string,
  endpoint: string | null,
  region: string | null,
): GeneratedFix | null {
  if (!SAFE_BUCKET.test(bucket)) return null
  const fix = build(rule.code, bucket)
  if (!fix) return null
  let command = fix.command
  if (endpoint || region) {
    const target = [
      endpoint ? `--endpoint-url ${quote(endpoint)}` : '',
      region ? `--region ${quote(region)}` : '',
    ]
      .filter(Boolean)
      .join(' ')
    command = command.replace('aws s3api ', `aws ${target} s3api `)
  }
  const formats: FixFormat[] = [{ label: 'AWS CLI', language: 'bash', text: command }]
  const tf = terraform(fix, bucket, endpoint, region)
  if (tf) formats.push({ label: 'Terraform', language: 'hcl', text: tf })
  formats.push({
    label: 'API document',
    language: 'json',
    text: JSON.stringify(fix.document, null, 2),
  })
  const notes = [...fix.notes]
  if (endpoint) notes.unshift(`Runs against ${endpoint} — use credentials for that account.`)
  return { formats, notes }
}

export function impactPreview(
  rule: Rule,
  posture: Record<string, unknown> | null,
  hasLifecycle: boolean,
): Impact {
  const reasons: string[] = []
  let verdict: Impact['verdict'] = 'low'
  if (!posture) {
    return {
      verdict: 'unknown',
      reasons: ['No recorded posture for this bucket.'],
      gap: 'Survey the account first so the preview can tell what this change affects.',
    }
  }
  if (rule.code === 'public_exposure') {
    verdict = 'caution'
    reasons.push(
      'The bucket is publicly exposed now; blocking public access will refuse anonymous reads.',
    )
    reasons.push(
      'If a website or public download depends on it, put a CDN with origin access in front first.',
    )
  } else if (rule.code === 'public_access_block_missing') {
    verdict = 'caution'
    reasons.push('Blocking public access refuses anonymous reads if any exist today.')
  } else if (rule.code === 'no_default_encryption') {
    reasons.push(
      'Only objects written after the change are encrypted; existing objects stay as they are until rewritten.',
    )
    reasons.push('Reads are unaffected.')
  } else if (rule.code === 'no_abort_mpu') {
    if (hasLifecycle) {
      verdict = 'caution'
      reasons.push(
        'The bucket already has lifecycle rules: this command replaces them, so merge the new rule first.',
      )
    }
    reasons.push(
      'Deletes incomplete multipart uploads older than 7 days; no completed object is touched.',
    )
  } else if (rule.code === 'noncurrent_never_expire') {
    if (hasLifecycle) {
      verdict = 'caution'
      reasons.push(
        'The bucket already has lifecycle rules: this command replaces them, so merge the new rule first.',
      )
    }
    reasons.push('Permanently deletes noncurrent versions older than 30 days.')
  } else {
    return {
      verdict: 'unknown',
      reasons: ['This issue depends on intent the rule cannot know.'],
      gap: 'Review the policy principals or CORS origins yourself before changing anything.',
    }
  }
  return { verdict, reasons, gap: null }
}
