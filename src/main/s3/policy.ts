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

/** One Allow statement, reduced to what a person can read. */
export interface PolicyStatement {
  principal: string
  actions: string[]
  condition: string | null
  public: boolean
}

export interface PolicyFacts {
  /** Some Allow statement names an everyone principal, conditional or not. */
  wildcardPrincipal: boolean
  /** An everyone-Allow exists but every one is narrowed by a restricting condition. */
  conditional: boolean
  publicRead: boolean
  publicList: boolean
  publicWrite: boolean
  /** A Deny for everyone on every S3 action when aws:SecureTransport is false. */
  enforcesTls: boolean
  /** The document could not be parsed; nothing above can be trusted. */
  unreadable: boolean
  /** Up to 20 Allow statements, for the access path. */
  statements: PolicyStatement[]
  /** The policy has more Allow statements than the access path shows. */
  statementsTruncated?: boolean
  /** Parsed statements, including Deny and conditions, for the access engine. */
  documents?: Record<string, unknown>[]
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
const WRITE_ACTIONS = [
  's3:PutObject',
  's3:DeleteObject',
  's3:PutObjectAcl',
  's3:PutObjectTagging',
  's3:DeleteObjectVersion',
  's3:AbortMultipartUpload',
  's3:PutBucketPolicy',
  's3:DeleteBucketPolicy',
  's3:PutBucketAcl',
  's3:PutBucketPublicAccessBlock',
  's3:PutBucketVersioning',
  's3:PutBucketLogging',
  's3:PutBucketWebsite',
  's3:PutBucketCors',
  's3:PutBucketNotification',
  's3:PutReplicationConfiguration',
  's3:PutLifecycleConfiguration',
  's3:DeleteBucket',
]

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

function glob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
}

function principalText(principal: unknown): string {
  if (principal === undefined || principal === null) return 'none'
  if (typeof principal === 'string') return principal
  if (typeof principal !== 'object') return String(principal)
  const parts: string[] = []
  for (const [kind, value] of Object.entries(principal as Record<string, unknown>)) {
    for (const item of list(value)) parts.push(`${kind}:${String(item)}`)
  }
  return parts.slice(0, 6).join(', ') || 'none'
}

function everyone(principal: unknown): boolean {
  if (principal === '*') return true
  if (!principal || typeof principal !== 'object') return false
  return list((principal as Record<string, unknown>).AWS).some((value) => value === '*')
}

/** A condition value that still lets everyone in. */
function everyoneValue(key: string, value: unknown): boolean {
  for (const item of list(value)) {
    const text = String(item ?? '').trim()
    if (!text || text === '*') return true
    if (key === 'aws:sourceip') {
      const [address, bits] = text.split('/')
      if (!address || !bits) continue
      // Only a /0 prefix covers the whole internet; any narrower network is a restriction.
      if (bits === '0') return true
    }
  }
  return false
}

function restricted(condition: unknown): boolean {
  if (!condition || typeof condition !== 'object') return false
  for (const block of Object.values(condition as Record<string, unknown>)) {
    if (!block || typeof block !== 'object') continue
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      const name = key.toLowerCase()
      if (!RESTRICTING_KEYS.has(name)) continue
      // A condition key with `*`, an empty value or 0.0.0.0/0 is not a restriction.
      if (everyoneValue(name, value)) continue
      return true
    }
  }
  return false
}

/** A Deny to everyone, on all of S3, when the request did not use TLS. */
function deniesPlainHttp(statement: Record<string, unknown>): boolean {
  if (!everyone(statement.Principal)) return false
  const actions = list(statement.Action).map((a) => String(a).toLowerCase())
  if (!actions.some((a) => a === 's3:*' || a === '*')) return false
  const condition = statement.Condition as Record<string, Record<string, unknown>> | undefined
  if (!condition) return false
  for (const [operator, block] of Object.entries(condition)) {
    if (!/^bool(ifexists)?$/i.test(operator) || !block) continue
    for (const [key, value] of Object.entries(block)) {
      if (key.toLowerCase() !== 'aws:securetransport') continue
      if (list(value).some((v) => String(v).toLowerCase() === 'false')) return true
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
    enforcesTls: false,
    unreadable: false,
    statements: [],
  }
  if (!document) return facts
  let parsed: { Statement?: unknown }
  try {
    parsed = JSON.parse(document) as { Statement?: unknown }
  } catch {
    return { ...facts, unreadable: true }
  }
  let unconditional = false
  const documents: Record<string, unknown>[] = []
  for (const raw of list(parsed?.Statement)) {
    if (!raw || typeof raw !== 'object') continue
    const statement = raw as Record<string, unknown>
    documents.push(statement)
    if (statement.Effect === 'Deny' && deniesPlainHttp(statement)) facts.enforcesTls = true
    if (statement.Effect !== 'Allow') continue
    const open = everyone(statement.Principal) || statement.NotPrincipal !== undefined
    if (facts.statements.length >= 20) facts.statementsTruncated = true
    else {
      const principal = statement.NotPrincipal
        ? `everyone except ${JSON.stringify(statement.NotPrincipal)}`
        : principalText(statement.Principal)
      const actions = statement.NotAction !== undefined ? ['*'] : list(statement.Action).map(String)
      const condition =
        statement.Condition && typeof statement.Condition === 'object'
          ? Object.entries(statement.Condition as Record<string, unknown>)
              .flatMap(([operator, block]) =>
                block && typeof block === 'object'
                  ? Object.keys(block as Record<string, unknown>).map((key) => `${operator}:${key}`)
                  : [],
              )
              .join(', ') || null
          : null
      facts.statements.push({
        principal,
        actions,
        condition,
        public: open && !restricted(statement.Condition),
      })
    }
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
  facts.documents = documents
  return facts
}

/** Whether the policy alone grants anonymous access to data. */
export function policyIsPublic(facts: PolicyFacts): boolean {
  return facts.publicRead || facts.publicList || facts.publicWrite
}
