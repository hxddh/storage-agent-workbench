/**
 * Local bucket-policy evaluation.
 *
 * S3-compatible providers rarely implement GetBucketPolicyStatus, so the policy
 * document itself is the only evidence of exposure there. This reads it the way
 * AWS defines "public": an Allow to everyone (`*`, `{"AWS":"*"}` or an Allow
 * with `NotPrincipal`) that no restricting condition narrows to a known network,
 * organization, account or principal. It is deliberately conservative: a Deny
 * is not subtracted, so a policy is never cleared by a statement this reader
 * cannot fully evaluate.
 */

export interface PolicyFacts {
  /** Some Allow statement names an everyone principal, conditional or not. */
  wildcardPrincipal: boolean
  /** An everyone-Allow exists but every one is narrowed by a restricting condition. */
  conditional: boolean
  publicRead: boolean
  publicList: boolean
  publicWrite: boolean
  /** The document could not be parsed; nothing above can be trusted. */
  unreadable: boolean
}

/** Condition keys that narrow an everyone-Allow to something that is not the public. */
const RESTRICTING_KEYS = new Set([
  'aws:sourceip',
  'aws:sourcevpc',
  'aws:sourcevpce',
  'aws:sourcearn',
  'aws:sourceaccount',
  'aws:sourceowner',
  'aws:principalorgid',
  'aws:principalorgpaths',
  'aws:principalaccount',
  'aws:principalarn',
  'aws:principalservicename',
  'aws:userid',
  'aws:username',
  's3:dataaccesspointaccount',
  's3:dataaccesspointarn',
])

const READ_ACTIONS = ['s3:GetObject', 's3:GetObjectVersion']
const LIST_ACTIONS = ['s3:ListBucket', 's3:ListBucketVersions']
const WRITE_ACTIONS = ['s3:PutObject', 's3:DeleteObject', 's3:PutObjectAcl', 's3:PutBucketPolicy']

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

function glob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
}

function everyone(principal: unknown): boolean {
  if (principal === '*') return true
  if (!principal || typeof principal !== 'object') return false
  return list((principal as Record<string, unknown>).AWS).some((value) => value === '*')
}

function restricted(condition: unknown): boolean {
  if (!condition || typeof condition !== 'object') return false
  for (const block of Object.values(condition as Record<string, unknown>)) {
    if (!block || typeof block !== 'object') continue
    for (const key of Object.keys(block as Record<string, unknown>)) {
      if (RESTRICTING_KEYS.has(key.toLowerCase())) return true
    }
  }
  return false
}

export function evaluatePolicy(document: string | undefined | null): PolicyFacts {
  const facts: PolicyFacts = {
    wildcardPrincipal: false,
    conditional: false,
    publicRead: false,
    publicList: false,
    publicWrite: false,
    unreadable: false,
  }
  if (!document) return facts
  let parsed: { Statement?: unknown }
  try {
    parsed = JSON.parse(document) as { Statement?: unknown }
  } catch {
    return { ...facts, unreadable: true }
  }
  let unconditional = false
  for (const raw of list(parsed?.Statement)) {
    if (!raw || typeof raw !== 'object') continue
    const statement = raw as Record<string, unknown>
    if (statement.Effect !== 'Allow') continue
    const open = everyone(statement.Principal) || statement.NotPrincipal !== undefined
    if (!open) continue
    facts.wildcardPrincipal = true
    if (restricted(statement.Condition)) continue
    unconditional = true
    // NotAction allows everything it does not name; treat it as every action.
    const patterns = statement.NotAction !== undefined ? ['*'] : list(statement.Action).map(String)
    const allows = (actions: string[]) =>
      patterns.some((pattern) => actions.some((action) => glob(pattern).test(action)))
    if (allows(READ_ACTIONS)) facts.publicRead = true
    if (allows(LIST_ACTIONS)) facts.publicList = true
    if (allows(WRITE_ACTIONS)) facts.publicWrite = true
  }
  facts.conditional = facts.wildcardPrincipal && !unconditional
  return facts
}

/** Whether the policy alone grants anonymous access to data. */
export function policyIsPublic(facts: PolicyFacts): boolean {
  return facts.publicRead || facts.publicList || facts.publicWrite
}
