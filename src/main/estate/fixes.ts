import type { FixFormat, Impact } from '@shared/contract'
import { ACCOUNT_SCOPE } from './rules'

/** A fix only needs the rule's code. */
type Rule = { code: string }

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

const TLS_STATEMENT = (bucket: string) => ({
  Sid: 'DenyInsecureTransport',
  Effect: 'Deny',
  Principal: '*',
  Action: 's3:*',
  Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
  Condition: { Bool: { 'aws:SecureTransport': 'false' } },
})

interface Fix {
  kind:
    | 'public_access_block'
    | 'default_encryption'
    | 'lifecycle'
    | 'policy'
    | 'ownership'
    | 'logging'
    | 'account_public_access_block'
  document: Record<string, unknown>
  command: string
  notes: string[]
}

function build(code: string, bucket: string): Fix | null {
  const b = quote(bucket)
  if (code === 'account_public_access_block_missing') {
    return {
      kind: 'account_public_access_block',
      document: PAB,
      command: `aws s3control put-public-access-block --account-id <account-id> --public-access-block-configuration ${jsonArg(PAB)}`,
      notes: [
        'Replace <account-id> with this account’s id; Storage Agent never stores it.',
        'Applies to every bucket in the account, including ones that serve public content on purpose.',
      ],
    }
  }
  if (code === 'insecure_transport') {
    const doc = { Version: '2012-10-17', Statement: [TLS_STATEMENT(bucket)] }
    return {
      kind: 'policy',
      document: doc,
      command: `aws s3api put-bucket-policy --bucket ${b} --policy ${jsonArg(doc)}`,
      notes: [
        'This call REPLACES the bucket policy: add the DenyInsecureTransport statement to the existing policy instead when there is one.',
        'Clients that still call over plain HTTP will be refused.',
      ],
    }
  }
  if (code === 'acls_enabled') {
    const doc = { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] }
    return {
      kind: 'ownership',
      document: doc,
      command: `aws s3api put-bucket-ownership-controls --bucket ${b} --ownership-controls ${jsonArg(doc)}`,
      notes: [
        'Disables every bucket and object ACL; the bucket owner owns all objects.',
        'Move any access granted by ACLs into the bucket policy first.',
      ],
    }
  }
  if (code === 'access_logging_off') {
    const doc = {
      LoggingEnabled: { TargetBucket: '<log-bucket>', TargetPrefix: `${bucket}/` },
    }
    return {
      kind: 'logging',
      document: doc,
      command: `aws s3api put-bucket-logging --bucket ${b} --bucket-logging-status ${jsonArg(doc)}`,
      notes: [
        'Replace <log-bucket> with a bucket in the same region whose policy lets logging.s3.amazonaws.com write to it.',
        'Never log a bucket into itself.',
      ],
    }
  }
  if (code === 'large_standard_only') {
    const doc = lifecycle(
      { Transitions: [{ Days: 30, StorageClass: 'INTELLIGENT_TIERING' }] },
      'intelligent-tiering-30d',
    )
    return {
      kind: 'lifecycle',
      document: doc,
      command: `aws s3api put-bucket-lifecycle-configuration --bucket ${b} --lifecycle-configuration ${jsonArg(doc)}`,
      notes: [
        'Objects move to Intelligent-Tiering after 30 days and then tier down as they go cold.',
        'Intelligent-Tiering adds a small monitoring fee per object; objects under 128 KiB never tier.',
        "This call REPLACES the bucket's lifecycle configuration: merge this rule into existing rules first.",
      ],
    }
  }
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
  } else if (fix.kind === 'account_public_access_block') {
    body =
      'resource "aws_s3_account_public_access_block" "account" {\n' +
      '  block_public_acls       = true\n  ignore_public_acls      = true\n' +
      '  block_public_policy     = true\n  restrict_public_buckets = true\n}'
  } else if (fix.kind === 'policy') {
    body =
      `# Merge into the bucket's existing policy document when there is one.\n` +
      `resource "aws_s3_bucket_policy" "${name}" {\n  bucket = ${b}\n  policy = jsonencode(${JSON.stringify(fix.document, null, 2).replace(/\n/g, '\n  ')})\n}`
  } else if (fix.kind === 'ownership') {
    body = `resource "aws_s3_bucket_ownership_controls" "${name}" {\n  bucket = ${b}\n\n  rule {\n    object_ownership = "BucketOwnerEnforced"\n  }\n}`
  } else if (fix.kind === 'logging') {
    body = `resource "aws_s3_bucket_logging" "${name}" {\n  bucket        = ${b}\n  target_bucket = "<log-bucket>"\n  target_prefix = ${tfString(`${bucket}/`)}\n}`
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
      const transitions = rule.Transitions as { Days?: number; StorageClass?: string }[] | undefined
      for (const transition of transitions ?? []) {
        lines.push(
          `    transition {\n      days          = ${transition.Days ?? 30}\n      storage_class = ${tfString(transition.StorageClass ?? 'INTELLIGENT_TIERING')}\n    }`,
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
  const account = bucket === ACCOUNT_SCOPE && rule.code === 'account_public_access_block_missing'
  if (!account && !SAFE_BUCKET.test(bucket)) return null
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
    if (account && region)
      command = command.replace('aws s3control ', `aws --region ${quote(region)} s3control `)
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
  if (rule.code === 'account_public_access_block_missing') {
    return {
      verdict: 'caution',
      reasons: [
        'Every bucket in the account loses public access at once, including any that serve public content on purpose.',
        'Survey the account first to see which buckets are public today.',
      ],
      gap: null,
    }
  }
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
  } else if (rule.code === 'insecure_transport') {
    verdict = posture.policy_status === 'available' ? 'caution' : 'low'
    if (posture.policy_status === 'available')
      reasons.push(
        'The bucket already has a policy: add the statement to it instead of replacing it.',
      )
    reasons.push('Requests over plain HTTP are refused; HTTPS clients are unaffected.')
  } else if (rule.code === 'acls_enabled') {
    verdict = 'caution'
    reasons.push(
      'Any access that ACLs grant today stops working; move it into the bucket policy first.',
    )
  } else if (rule.code === 'access_logging_off') {
    verdict = 'unknown'
    reasons.push('Logs cost storage in the target bucket; reads and writes are unaffected.')
    return {
      verdict,
      reasons,
      gap: 'The target log bucket is your choice; the fix leaves it as <log-bucket>.',
    }
  } else if (rule.code === 'large_standard_only') {
    if (hasLifecycle) {
      verdict = 'caution'
      reasons.push(
        'The bucket already has lifecycle rules: this command replaces them, so merge the new rule first.',
      )
    }
    reasons.push(
      'No data is deleted; objects keep their keys and stay readable at the same latency.',
    )
    const usd = typeof posture.monthly_usd === 'number' ? posture.monthly_usd : null
    if (usd)
      reasons.push(
        `Storage is about $${usd}/month at list price today; cold objects tier down and cost less.`,
      )
  } else {
    return {
      verdict: 'unknown',
      reasons: ['This issue depends on intent the rule cannot know.'],
      gap: 'Review the policy principals or CORS origins yourself before changing anything.',
    }
  }
  return { verdict, reasons, gap: null }
}
