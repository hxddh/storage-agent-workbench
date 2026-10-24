import type { ConfigFinding, Severity } from '@shared/contract'
import { type BucketFacts, blindSpots, type ExposureReason } from '../s3/facts'
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
  decide: (facts: BucketFacts, words: Words) => Decision
}

/** Evidence phrases, written for each language rather than translated word for word. */
const WORDS = {
  en: {
    unreadable: (item: string, status: string) => `${item} could not be read (${status})`,
    status: {
      access_denied: 'access denied',
      provider_unsupported: 'not supported by the provider',
      error: 'error',
      region_mismatch: 'wrong region',
      missing: 'bucket missing',
    } as Record<string, string>,
    items: {
      policy: 'The bucket policy',
      cors: 'CORS',
      encryption: 'Encryption',
      pab: 'The public access block',
      lifecycle: 'Lifecycle',
      versioning: 'Versioning',
    },
    exposure: {
      status_public: 'the provider reports the bucket policy as public',
      policy_write: 'the policy lets anyone write objects',
      policy_read: 'the policy lets anyone read objects',
      policy_list: 'the policy lets anyone list the bucket',
      policy_unknown: 'the bucket policy could not be evaluated',
      acl_everyone: 'the ACL grants access to everyone',
      acl_authenticated: 'the ACL grants access to any authenticated AWS user',
      acl_unknown: 'the ACL could not be read',
      restrict_blocks: 'RestrictPublicBuckets blocks the public policy',
      ignore_blocks: 'IgnorePublicAcls blocks the public ACL',
      account_block_unread: 'an account-level public access block, if set, would still apply',
      not_read: 'not read',
    } as Record<ExposureReason, string>,
    join: '; ',
    policyInvalid: 'The bucket policy is not valid JSON',
    wildcardNarrowed:
      'An Allow names Principal "*", narrowed by a network, organization or account condition',
    wildcardOpen: 'An Allow names Principal "*" with no restricting condition',
    corsAll: "A CORS rule allows origin '*'",
    noEncryption: 'No default server-side encryption is configured',
    noPab: 'No public access block is configured on the bucket',
    pabOff: (names: string[]) => `Off: ${names.join(', ')}`,
    noLifecycle: 'The bucket has no lifecycle rules',
    noAbort: (n: number) =>
      `${n} lifecycle rule${n === 1 ? '' : 's'}, none aborts incomplete uploads`,
    versionedNoLifecycle: 'Versioning is on and there are no lifecycle rules',
    versionedNoExpiry: 'Versioning is on and no rule expires noncurrent versions',
  },
  zh: {
    unreadable: (item: string, status: string) => `${item}无法读取（${status}）`,
    status: {
      access_denied: '无权访问',
      provider_unsupported: '服务商不支持',
      error: '出错',
      region_mismatch: '区域不匹配',
      missing: '存储桶不存在',
    } as Record<string, string>,
    items: {
      policy: '存储桶策略',
      cors: 'CORS',
      encryption: '加密配置',
      pab: '阻止公共访问配置',
      lifecycle: '生命周期',
      versioning: '版本控制',
    },
    exposure: {
      status_public: '服务商判定存储桶策略为公开',
      policy_write: '策略允许任何人写入对象',
      policy_read: '策略允许任何人读取对象',
      policy_list: '策略允许任何人列出存储桶',
      policy_unknown: '无法评估存储桶策略',
      acl_everyone: 'ACL 向所有人授权',
      acl_authenticated: 'ACL 向任意已认证的 AWS 用户授权',
      acl_unknown: '无法读取 ACL',
      restrict_blocks: 'RestrictPublicBuckets 阻止了公开策略',
      ignore_blocks: 'IgnorePublicAcls 阻止了公开 ACL',
      account_block_unread: '账号级阻止公共访问未读取，如已开启仍会生效',
      not_read: '未读取',
    } as Record<ExposureReason, string>,
    join: '；',
    policyInvalid: '存储桶策略不是有效的 JSON',
    wildcardNarrowed: '有一条 Allow 指定了 Principal "*"，但被网络、组织或账号条件限定',
    wildcardOpen: '有一条 Allow 指定了 Principal "*"，且没有限定条件',
    corsAll: "有一条 CORS 规则允许来源 '*'",
    noEncryption: '未配置默认服务端加密',
    noPab: '存储桶未配置阻止公共访问',
    pabOff: (names: string[]) => `未开启：${names.join('、')}`,
    noLifecycle: '存储桶没有生命周期规则',
    noAbort: (n: number) => `${n} 条生命周期规则，都不会清理未完成的上传`,
    versionedNoLifecycle: '已开启版本控制，但没有生命周期规则',
    versionedNoExpiry: '已开启版本控制，但没有规则让非当前版本过期',
  },
}

export type Words = (typeof WORDS)['en']

export function wordsFor(lang: string): Words {
  return lang.toLowerCase().startsWith('zh') ? WORDS.zh : WORDS.en
}

function undecided(status: ReadStatus, item: string, w: Words): Decision {
  return status === 'unread'
    ? { verdict: null, detail: null }
    : { verdict: null, detail: w.unreadable(item, w.status[status] ?? status) }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const RULES: Rule[] = [
  {
    code: 'public_exposure',
    severity: 'high',
    title: { en: 'Bucket is publicly accessible', zh: '存储桶可被公开访问' },
    decide: (facts, w) => {
      const exposure = facts.exposure
      if (facts.policy.status === 'unread') return { verdict: null, detail: null }
      return {
        verdict: exposure.verdict,
        detail: exposure.reasons.length
          ? capitalize(exposure.reasons.map((reason) => w.exposure[reason]).join(w.join))
          : null,
      }
    },
  },
  {
    code: 'wildcard_principal',
    severity: 'medium',
    title: { en: 'Bucket policy allows a wildcard principal', zh: '存储桶策略允许通配主体' },
    decide: (facts, w) => {
      if (facts.policy.status === 'not_configured') return { verdict: false, detail: null }
      if (facts.policy.status !== 'available' || !facts.policy.value)
        return undecided(facts.policy.status, w.items.policy, w)
      if (facts.policy.value.unreadable) return { verdict: null, detail: w.policyInvalid }
      return {
        verdict: facts.policy.value.wildcardPrincipal,
        detail: facts.policy.value.conditional
          ? w.wildcardNarrowed
          : facts.policy.value.wildcardPrincipal
            ? w.wildcardOpen
            : null,
      }
    },
  },
  {
    code: 'cors_all_origins',
    severity: 'medium',
    title: { en: 'CORS allows all origins', zh: 'CORS 允许所有来源' },
    decide: (facts, w) => {
      if (facts.cors.status === 'not_configured') return { verdict: false, detail: null }
      if (facts.cors.status !== 'available' || !facts.cors.value)
        return undecided(facts.cors.status, w.items.cors, w)
      return {
        verdict: facts.cors.value.allOrigins,
        detail: facts.cors.value.allOrigins ? w.corsAll : null,
      }
    },
  },
  {
    code: 'no_default_encryption',
    severity: 'medium',
    title: { en: 'No default encryption', zh: '未配置默认加密' },
    decide: (facts, w) => {
      if (facts.encryption.status === 'not_configured')
        return { verdict: true, detail: w.noEncryption }
      if (facts.encryption.status === 'available') return { verdict: false, detail: null }
      return undecided(facts.encryption.status, w.items.encryption, w)
    },
  },
  {
    code: 'public_access_block_missing',
    severity: 'medium',
    title: { en: 'Public access block not fully enabled', zh: '阻止公共访问未完全开启' },
    decide: (facts, w) => {
      if (facts.pab.status === 'not_configured') return { verdict: true, detail: w.noPab }
      if (facts.pab.status !== 'available' || !facts.pab.value)
        return undecided(facts.pab.status, w.items.pab, w)
      const off = Object.entries(facts.pab.value)
        .filter(([, on]) => !on)
        .map(([key]) => key.charAt(0).toUpperCase() + key.slice(1))
      return { verdict: off.length > 0, detail: off.length ? w.pabOff(off) : null }
    },
  },
  {
    code: 'no_abort_mpu',
    severity: 'medium',
    title: {
      en: 'Incomplete multipart uploads are never cleaned up',
      zh: '未完成的分段上传从不清理',
    },
    decide: (facts, w) => {
      if (facts.lifecycle.status === 'not_configured')
        return { verdict: true, detail: w.noLifecycle }
      if (facts.lifecycle.status !== 'available' || !facts.lifecycle.value)
        return undecided(facts.lifecycle.status, w.items.lifecycle, w)
      return {
        verdict: !facts.lifecycle.value.abortMpu,
        detail: facts.lifecycle.value.abortMpu ? null : w.noAbort(facts.lifecycle.value.rules),
      }
    },
  },
  {
    code: 'noncurrent_never_expire',
    severity: 'medium',
    title: { en: 'Noncurrent versions never expire', zh: '非当前版本永不过期' },
    decide: (facts, w) => {
      if (facts.versioning.status === 'not_configured') return { verdict: false, detail: null }
      if (facts.versioning.status !== 'available' || !facts.versioning.value)
        return undecided(facts.versioning.status, w.items.versioning, w)
      const versioned = facts.versioning.value.enabled || facts.versioning.value.suspended
      if (!versioned) return { verdict: false, detail: null }
      if (facts.lifecycle.status === 'not_configured')
        return { verdict: true, detail: w.versionedNoLifecycle }
      if (facts.lifecycle.status !== 'available' || !facts.lifecycle.value)
        return undecided(facts.lifecycle.status, w.items.lifecycle, w)
      return {
        verdict: !facts.lifecycle.value.noncurrentExpiration,
        detail: facts.lifecycle.value.noncurrentExpiration ? null : w.versionedNoExpiry,
      }
    },
  },
]

export const BY_CODE = new Map(RULES.map((rule) => [rule.code, rule]))

export function ruleTitle(rule: Rule, lang: string): string {
  return lang.toLowerCase().startsWith('zh') ? rule.title.zh : rule.title.en
}

/** Every rule the reading decided. A rule left out could not be decided. */
export function decide(facts: BucketFacts, lang = 'en'): Record<string, Decision> {
  const words = wordsFor(lang)
  const out: Record<string, Decision> = {}
  for (const rule of RULES) {
    const decision = rule.decide(facts, words)
    if (decision.verdict !== null) out[rule.code] = decision
  }
  return out
}

/** Rules a reading could not decide because a read it needed was blind. */
export function undecidedRules(
  facts: BucketFacts,
  lang = 'en',
): { code: string; detail: string }[] {
  const words = wordsFor(lang)
  const out: { code: string; detail: string }[] = []
  for (const rule of RULES) {
    const decision = rule.decide(facts, words)
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
  const words = wordsFor(lang)
  const findings: ConfigFinding[] = []
  let passed = 0
  for (const code of ASPECT_RULES[aspect]) {
    const rule = BY_CODE.get(code)!
    const decision = rule.decide(facts, words)
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
