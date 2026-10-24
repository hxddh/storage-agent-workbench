import type { ConfigFinding, Severity } from '@shared/contract'
import { type BucketFacts, blindSpots } from '../s3/facts'
import type { ReadStatus } from '../s3/status'

/** true: the problem is there; false: it is proved absent; null: a read was blind. */
export type Verdict = boolean | null

export interface Decision {
  verdict: Verdict
  /** Why, in a short plain phrase; never a policy document or an account id. */
  detail: string | null
}

export interface Rule {
  code: string
  severity: Severity
  title: { en: string; zh: string }
  decide: (facts: BucketFacts) => Decision
}

function undecided(status: ReadStatus, item: string): Decision {
  return status === 'unread'
    ? { verdict: null, detail: null }
    : { verdict: null, detail: `${item} could not be read (${status.replace(/_/g, ' ')})` }
}

export const RULES: Rule[] = [
  {
    code: 'public_exposure',
    severity: 'high',
    title: { en: 'Bucket is publicly accessible', zh: '存储桶可被公开访问' },
    decide: (facts) => {
      const exposure = facts.exposure
      if (facts.policy.status === 'unread') return { verdict: null, detail: null }
      return {
        verdict: exposure.verdict,
        detail: exposure.reasons.length ? capitalize(exposure.reasons.join('; ')) : null,
      }
    },
  },
  {
    code: 'wildcard_principal',
    severity: 'medium',
    title: { en: 'Bucket policy allows a wildcard principal', zh: '存储桶策略允许通配主体' },
    decide: (facts) => {
      if (facts.policy.status === 'not_configured') return { verdict: false, detail: null }
      if (facts.policy.status !== 'available' || !facts.policy.value)
        return undecided(facts.policy.status, 'The bucket policy')
      if (facts.policy.value.unreadable)
        return { verdict: null, detail: 'The bucket policy is not valid JSON' }
      return {
        verdict: facts.policy.value.wildcardPrincipal,
        detail: facts.policy.value.conditional
          ? 'An Allow names Principal "*", narrowed by a network, organization or account condition'
          : facts.policy.value.wildcardPrincipal
            ? 'An Allow names Principal "*" with no restricting condition'
            : null,
      }
    },
  },
  {
    code: 'cors_all_origins',
    severity: 'medium',
    title: { en: 'CORS allows all origins', zh: 'CORS 允许所有来源' },
    decide: (facts) => {
      if (facts.cors.status === 'not_configured') return { verdict: false, detail: null }
      if (facts.cors.status !== 'available' || !facts.cors.value)
        return undecided(facts.cors.status, 'CORS')
      return {
        verdict: facts.cors.value.allOrigins,
        detail: facts.cors.value.allOrigins ? "A CORS rule allows origin '*'" : null,
      }
    },
  },
  {
    code: 'no_default_encryption',
    severity: 'medium',
    title: { en: 'No default encryption', zh: '未配置默认加密' },
    decide: (facts) => {
      if (facts.encryption.status === 'not_configured')
        return { verdict: true, detail: 'No default server-side encryption is configured' }
      if (facts.encryption.status === 'available') return { verdict: false, detail: null }
      return undecided(facts.encryption.status, 'Encryption')
    },
  },
  {
    code: 'public_access_block_missing',
    severity: 'medium',
    title: { en: 'Public access block not fully enabled', zh: '阻止公共访问未完全开启' },
    decide: (facts) => {
      if (facts.pab.status === 'not_configured')
        return { verdict: true, detail: 'No public access block is configured on the bucket' }
      if (facts.pab.status !== 'available' || !facts.pab.value)
        return undecided(facts.pab.status, 'The public access block')
      const off = Object.entries(facts.pab.value)
        .filter(([, on]) => !on)
        .map(([key]) => key.charAt(0).toUpperCase() + key.slice(1))
      return {
        verdict: off.length > 0,
        detail: off.length ? `Off: ${off.join(', ')}` : null,
      }
    },
  },
  {
    code: 'no_abort_mpu',
    severity: 'medium',
    title: {
      en: 'Incomplete multipart uploads are never cleaned up',
      zh: '未完成的分段上传从不清理',
    },
    decide: (facts) => {
      if (facts.lifecycle.status === 'not_configured')
        return { verdict: true, detail: 'The bucket has no lifecycle rules' }
      if (facts.lifecycle.status !== 'available' || !facts.lifecycle.value)
        return undecided(facts.lifecycle.status, 'Lifecycle')
      return {
        verdict: !facts.lifecycle.value.abortMpu,
        detail: facts.lifecycle.value.abortMpu
          ? null
          : `${facts.lifecycle.value.rules} lifecycle rule(s), none aborts incomplete uploads`,
      }
    },
  },
  {
    code: 'noncurrent_never_expire',
    severity: 'medium',
    title: { en: 'Noncurrent versions never expire', zh: '非当前版本永不过期' },
    decide: (facts) => {
      if (facts.versioning.status === 'not_configured') return { verdict: false, detail: null }
      if (facts.versioning.status !== 'available' || !facts.versioning.value)
        return undecided(facts.versioning.status, 'Versioning')
      const versioned = facts.versioning.value.enabled || facts.versioning.value.suspended
      if (!versioned) return { verdict: false, detail: null }
      if (facts.lifecycle.status === 'not_configured')
        return { verdict: true, detail: 'Versioning is on and there are no lifecycle rules' }
      if (facts.lifecycle.status !== 'available' || !facts.lifecycle.value)
        return undecided(facts.lifecycle.status, 'Lifecycle')
      return {
        verdict: !facts.lifecycle.value.noncurrentExpiration,
        detail: facts.lifecycle.value.noncurrentExpiration
          ? null
          : 'Versioning is on and no rule expires noncurrent versions',
      }
    },
  },
]

export const BY_CODE = new Map(RULES.map((rule) => [rule.code, rule]))

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function ruleTitle(rule: Rule, lang: string): string {
  return lang.toLowerCase().startsWith('zh') ? rule.title.zh : rule.title.en
}

/** Every rule the reading decided. A rule left out could not be decided. */
export function decide(facts: BucketFacts): Record<string, Decision> {
  const out: Record<string, Decision> = {}
  for (const rule of RULES) {
    const decision = rule.decide(facts)
    if (decision.verdict !== null) out[rule.code] = decision
  }
  return out
}

/** Rules a reading could not decide because a read it needed was blind. */
export function undecidedRules(facts: BucketFacts): { code: string; detail: string }[] {
  const out: { code: string; detail: string }[] = []
  for (const rule of RULES) {
    const decision = rule.decide(facts)
    if (decision.verdict === null && decision.detail)
      out.push({ code: rule.code, detail: decision.detail })
  }
  return out
}

interface Advisory {
  code: string
  title: { en: string; zh: string }
  detail: { en: string; zh: string }
  applies: (facts: BucketFacts) => boolean
}

/** Low-severity observations a review shows. They never open an Issue. */
const ADVISORIES: Advisory[] = [
  {
    code: 'acls_active',
    title: { en: 'ACLs are still active', zh: 'ACL 仍处于启用状态' },
    detail: {
      en: 'Object Ownership is not BucketOwnerEnforced.',
      zh: '对象所有权不是 BucketOwnerEnforced。',
    },
    applies: (f) =>
      f.ownership.status === 'available' && f.ownership.value?.mode !== 'BucketOwnerEnforced',
  },
  {
    code: 'no_expiration',
    title: { en: 'No expiration rules', zh: '没有过期规则' },
    detail: {
      en: 'No lifecycle rule expires current objects.',
      zh: '没有生命周期规则使当前对象过期。',
    },
    applies: (f) => f.lifecycle.status === 'available' && !f.lifecycle.value?.expiration,
  },
  {
    code: 'no_transition',
    title: { en: 'No storage-class transitions', zh: '没有存储类别转换' },
    detail: {
      en: 'No lifecycle rule moves objects to a cheaper class.',
      zh: '没有生命周期规则把对象转入更便宜的存储类别。',
    },
    applies: (f) => f.lifecycle.status === 'available' && !f.lifecycle.value?.transition,
  },
  {
    code: 'logging_off',
    title: { en: 'Server access logging is off', zh: '服务器访问日志未开启' },
    detail: {
      en: 'There is no access log to audit or analyze.',
      zh: '没有可供审计或分析的访问日志。',
    },
    applies: (f) =>
      (f.logging.status === 'available' && !f.logging.value?.enabled) ||
      f.logging.status === 'not_configured',
  },
  {
    code: 'no_tags',
    title: { en: 'No bucket tags', zh: '存储桶没有标签' },
    detail: {
      en: 'Tags carry ownership and cost attribution.',
      zh: '标签用于记录归属和成本分摊。',
    },
    applies: (f) => f.tagging.status === 'not_configured',
  },
]

const ASPECT_RULES: Record<'security' | 'lifecycle' | 'observability', string[]> = {
  security: [
    'public_exposure',
    'wildcard_principal',
    'cors_all_origins',
    'no_default_encryption',
    'public_access_block_missing',
  ],
  lifecycle: ['no_abort_mpu', 'noncurrent_never_expire'],
  observability: [],
}

const ASPECT_ADVISORIES: Record<'security' | 'lifecycle' | 'observability', string[]> = {
  security: ['acls_active'],
  lifecycle: ['no_expiration', 'no_transition'],
  observability: ['logging_off', 'no_tags'],
}

const BLIND_TITLE = {
  access_denied: { en: 'Access denied reading', zh: '无权读取' },
  provider_unsupported: { en: 'Not supported by the provider:', zh: '服务商不支持：' },
  error: { en: 'Could not read', zh: '无法读取' },
  region_mismatch: { en: 'Wrong region for', zh: '区域不匹配：' },
} as Record<string, { en: string; zh: string }>

/** What a single-bucket review shows: problems, blind spots and passes, each with a code. */
export function reviewFindings(
  facts: BucketFacts,
  aspect: 'security' | 'lifecycle' | 'observability',
  lang: string,
): { findings: ConfigFinding[]; passed: number } {
  const zh = lang.toLowerCase().startsWith('zh')
  const findings: ConfigFinding[] = []
  let passed = 0
  for (const code of ASPECT_RULES[aspect]) {
    const rule = BY_CODE.get(code)!
    const decision = rule.decide(facts)
    if (decision.verdict === true) {
      findings.push({
        severity: rule.severity,
        title: ruleTitle(rule, lang),
        detail: decision.detail ?? '',
        code,
      })
    } else if (decision.verdict === false) passed += 1
  }
  for (const code of ASPECT_ADVISORIES[aspect]) {
    const advisory = ADVISORIES.find((item) => item.code === code)!
    if (advisory.applies(facts)) {
      findings.push({
        severity: 'low',
        title: zh ? advisory.title.zh : advisory.title.en,
        detail: zh ? advisory.detail.zh : advisory.detail.en,
        code: `advice:${code}`,
      })
    }
  }
  for (const spot of blindSpots(facts)) {
    const label = BLIND_TITLE[spot.status]
    if (!label) continue
    findings.push({
      severity: 'blind',
      title: `${zh ? label.zh : label.en} ${spot.item}`,
      detail: zh
        ? '这一项未被评估，相关规则保持未判定。'
        : 'This aspect is unassessed; rules that need it stay undecided.',
      code: `blind:${spot.item.replace(/\s+/g, '_')}`,
    })
  }
  return { findings, passed }
}

export function aspectsOf(aspect: 'security' | 'lifecycle' | 'observability'): string[] {
  return ASPECT_RULES[aspect]
}
