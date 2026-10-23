import type { Severity } from '@shared/contract'
import type { Posture } from '../s3/posture'
import type { Finding } from '../s3/review'

export type Verdict = boolean | null

export interface Rule {
  code: string
  severity: Severity
  title: { en: string; zh: string }
  check: 'security' | 'lifecycle'
  reviewTitles: string[]
  posture?: (p: Posture) => Verdict
}

export const RULES: Rule[] = [
  {
    code: 'public_exposure',
    severity: 'high',
    title: { en: 'Bucket is publicly accessible', zh: '存储桶可被公开访问' },
    check: 'security',
    reviewTitles: [
      'Anonymous s3:GetObject allowed',
      'Anonymous s3:ListBucket allowed',
      'ACL grants public access',
      'Bucket policy makes this bucket PUBLIC (AWS verdict)',
    ],
    posture: (p) => (p.publicly_exposed === null ? null : p.publicly_exposed),
  },
  {
    code: 'wildcard_principal',
    severity: 'medium',
    title: { en: 'Bucket policy allows a wildcard principal', zh: '存储桶策略允许通配主体' },
    check: 'security',
    reviewTitles: ['Bucket policy allows a wildcard principal'],
  },
  {
    code: 'cors_all_origins',
    severity: 'medium',
    title: { en: 'CORS allows all origins', zh: 'CORS 允许所有来源' },
    check: 'security',
    reviewTitles: ['CORS allows all origins'],
  },
  {
    code: 'no_default_encryption',
    severity: 'medium',
    title: { en: 'No default encryption', zh: '未配置默认加密' },
    check: 'security',
    reviewTitles: ['No default encryption'],
    posture: (p) =>
      p.encryption_status === 'not_configured'
        ? true
        : p.encryption_status === 'available'
          ? false
          : null,
  },
  {
    code: 'public_access_block_missing',
    severity: 'medium',
    title: { en: 'Public access block not fully enabled', zh: '阻止公共访问未完全开启' },
    check: 'security',
    reviewTitles: ['Public access block incomplete', 'Public access block not configured'],
    posture: (p) => (p.public_access_block_status === 'not_configured' ? true : null),
  },
  {
    code: 'no_abort_mpu',
    severity: 'medium',
    title: {
      en: 'Incomplete multipart uploads are never cleaned up',
      zh: '未完成的分段上传从不清理',
    },
    check: 'lifecycle',
    reviewTitles: ['No AbortIncompleteMultipartUpload rule', 'No incomplete-multipart cleanup'],
    posture: (p) => (p.lifecycle_status === 'not_configured' ? true : null),
  },
  {
    code: 'noncurrent_never_expire',
    severity: 'medium',
    title: { en: 'Noncurrent versions never expire', zh: '非当前版本永不过期' },
    check: 'lifecycle',
    reviewTitles: [
      'Versioning enabled without noncurrent cleanup',
      'Noncurrent versions never expire',
    ],
  },
]

export const BY_CODE = new Map(RULES.map((r) => [r.code, r]))
const BY_TITLE = new Map<string, Rule>()
for (const rule of RULES) for (const title of rule.reviewTitles) BY_TITLE.set(title, rule)

const BLIND_PREFIXES = [
  'Access denied reading',
  'Could not read',
  'Policy not public, but ACL unreadable',
]
const BLIND_SUFFIXES = ['not supported', 'not supported by provider']

export function ruleTitle(rule: Rule, lang: string): string {
  return lang.toLowerCase().startsWith('zh') ? rule.title.zh : rule.title.en
}

/** Every rule the survey's posture flags can decide. `null` means it could not decide. */
export function evaluatePosture(posture: Posture): Record<string, Verdict> {
  const out: Record<string, Verdict> = {}
  for (const rule of RULES) {
    if (!rule.posture) continue
    const verdict = rule.posture(posture)
    if (verdict !== null) out[rule.code] = verdict
  }
  return out
}

function blind(title: string): boolean {
  return (
    BLIND_PREFIXES.some((prefix) => title.startsWith(prefix)) ||
    BLIND_SUFFIXES.some((suffix) => title.endsWith(suffix))
  )
}

/**
 * A rule present in a review's findings is observed. A rule that does not
 * appear is absent only when the review could see everything; a blind spot
 * decides nothing.
 */
export function evaluateReview(
  check: 'security' | 'lifecycle',
  findings: Finding[],
): { verdicts: Record<string, Verdict>; details: Record<string, string> } {
  const verdicts: Record<string, Verdict> = {}
  const details: Record<string, string> = {}
  const hasBlindSpot = findings.some((f) => blind(f.title))
  for (const f of findings) {
    const rule = BY_TITLE.get(f.title)
    if (!rule || rule.check !== check) continue
    verdicts[rule.code] = true
    const detail = (f.detail || f.title).slice(0, 400)
    details[rule.code] = details[rule.code] ? `${details[rule.code]} ${detail}` : detail
  }
  if (!hasBlindSpot) {
    for (const rule of RULES) {
      if (rule.check === check && !(rule.code in verdicts)) verdicts[rule.code] = false
    }
  }
  return { verdicts, details }
}
