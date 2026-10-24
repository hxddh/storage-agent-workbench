/**
 * Who can reach a bucket.
 *
 * This is evidence, not an authorization decision. Bucket policy, ACL and KMS
 * grants are read locally. IAM is read once with GetAccountAuthorizationDetails
 * and evaluated locally, so the answer covers the account instead of a sample
 * of the first few principals. Conditions and sources this reader cannot
 * evaluate are reported as undecided; they are never turned into a clean answer.
 */
import {
  type AccessAnalyzerClient,
  ListAnalyzersCommand,
  ListFindingsCommand,
} from '@aws-sdk/client-accessanalyzer'
import {
  GetAccountAuthorizationDetailsCommand,
  type GroupDetail,
  type IAMClient,
  type ManagedPolicyDetail,
  type RoleDetail,
  type UserDetail,
} from '@aws-sdk/client-iam'
import { DescribeKeyCommand, GetKeyPolicyCommand, type KMSClient } from '@aws-sdk/client-kms'
import {
  DescribePolicyCommand,
  ListParentsCommand,
  ListPoliciesForTargetCommand,
  type OrganizationsClient,
} from '@aws-sdk/client-organizations'
import type { AccessCoverage, AccessPath } from '@shared/contract'
import type { BucketFacts } from './facts'
import { evaluatePolicy } from './policy'
import { classify, isAbort, type ReadStatus } from './status'

export interface AccessRead {
  paths: AccessPath[]
  blind: { source: string; status: ReadStatus }[]
  coverage: AccessCoverage
  /** AWS requests made while reading; code mode charges these to its budget. */
  calls?: number
}

const READ_ACTIONS = [
  's3:GetObject',
  's3:GetObjectVersion',
  's3:ListBucket',
  's3:ListBucketVersions',
  's3:GetBucketAcl',
  's3:GetBucketPolicy',
]
const CHANGE_ACTIONS = [
  's3:PutObject',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:PutObjectAcl',
  's3:PutObjectTagging',
  's3:DeleteObjectTagging',
  's3:AbortMultipartUpload',
  's3:PutBucketAcl',
  's3:PutBucketPolicy',
  's3:DeleteBucketPolicy',
  's3:PutBucketPublicAccessBlock',
  's3:PutBucketVersioning',
  's3:PutBucketLogging',
  's3:PutBucketCors',
  's3:PutLifecycleConfiguration',
  's3:PutReplicationConfiguration',
  's3:DeleteBucket',
]
const IAM_ACTIONS = [...READ_ACTIONS, ...CHANGE_ACTIONS]

function path(
  source: AccessPath['source'],
  principal: string,
  actions: string[],
  condition: string | null,
  isPublic = false,
  note: string | null = null,
): AccessPath {
  return {
    source,
    principal: principal.replace(/\b\d{12}\b/g, '<account>').slice(0, 240),
    actions: [...new Set(actions)].slice(0, 20),
    condition,
    public: isPublic,
    note,
  }
}

function statementsOf(parsed: unknown): Record<string, unknown>[] {
  if (!parsed || typeof parsed !== 'object') return []
  const statement = (parsed as { Statement?: unknown }).Statement
  if (Array.isArray(statement)) return statement as Record<string, unknown>[]
  return statement && typeof statement === 'object' ? [statement as Record<string, unknown>] : []
}

function policyDocuments(document: string | undefined): Record<string, unknown>[] {
  if (!document) return []
  try {
    return statementsOf(JSON.parse(document))
  } catch {
    try {
      return statementsOf(JSON.parse(decodeURIComponent(document)))
    } catch {
      return []
    }
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

function glob(pattern: string, flags = ''): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, flags)
}

function matches(value: string, pattern: string, flags = ''): boolean {
  return glob(pattern, flags).test(value)
}

/** IAM action names are case-insensitive; ARNs are not. */
function matchesAction(statement: Record<string, unknown>, action: string): boolean {
  if (statement.NotAction !== undefined)
    return !list(statement.NotAction).some((item) => matches(action, String(item), 'i'))
  const actions = list(statement.Action)
  // A statement without an Action is malformed; never widen it to every action.
  return actions.length > 0 && actions.some((item) => matches(action, String(item), 'i'))
}

const OBJECT_ACTIONS = new Set([
  's3:getobject',
  's3:getobjectversion',
  's3:putobject',
  's3:deleteobject',
  's3:deleteobjectversion',
  's3:getobjectacl',
  's3:putobjectacl',
  's3:getobjecttagging',
  's3:putobjecttagging',
  's3:deleteobjecttagging',
  's3:getobjectversionacl',
  's3:getobjectversiontagging',
  's3:abortmultipartupload',
])

/** The one resource an action needs. Object actions never match a bucket ARN. */
function resourceForAction(bucket: string, action: string): string {
  return OBJECT_ACTIONS.has(action.toLowerCase())
    ? `arn:aws:s3:::${bucket}/*`
    : `arn:aws:s3:::${bucket}`
}

function matchesResource(
  statement: Record<string, unknown>,
  bucket: string,
  action: string,
): boolean {
  const resource = resourceForAction(bucket, action)
  if (statement.NotResource !== undefined) {
    const excluded = list(statement.NotResource).map(String)
    return !excluded.some((pattern) => matches(resource, pattern))
  }
  const patterns = list(statement.Resource)
  // As with Action, an omitted Resource is not a wildcard.
  return patterns.some((item) => matches(resource, String(item)))
}

function conditionText(statement: Record<string, unknown>): string | null {
  const condition = statement.Condition
  if (!condition || typeof condition !== 'object') return null
  return (
    Object.entries(condition as Record<string, unknown>)
      .flatMap(([operator, block]) =>
        block && typeof block === 'object'
          ? Object.keys(block as Record<string, unknown>).map((key) => `${operator}:${key}`)
          : [],
      )
      .slice(0, 6)
      .join(', ')
      .slice(0, 240) || 'condition present'
  )
}

function hasCondition(statement: Record<string, unknown>): boolean {
  return Boolean(statement.Condition && typeof statement.Condition === 'object')
}

export interface PrincipalRef {
  kind: 'user' | 'role'
  name: string
  arn?: string
  accountId?: string
}

function awsPrincipalMatches(value: string, ref: PrincipalRef): boolean {
  if (value === '*') return true
  if (ref.arn && value === ref.arn) return true
  if (ref.accountId && (value === ref.accountId || value === `arn:aws:iam::${ref.accountId}:root`))
    return true
  // A policy can name a user/role ARN from the same account even when the
  // detail response omitted the full ARN; compare the stable suffix then.
  const suffix = `:${ref.kind}/${ref.name}`
  if (value.endsWith(suffix)) {
    if (!ref.accountId) return true
    return value.includes(`::${ref.accountId}:`)
  }
  return false
}

function principalMatches(raw: unknown, ref: PrincipalRef): boolean {
  if (raw === '*') return true
  if (typeof raw === 'string') return awsPrincipalMatches(raw, ref)
  if (Array.isArray(raw)) return raw.some((item) => principalMatches(item, ref))
  if (!raw || typeof raw !== 'object') return false
  for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kind !== 'AWS') continue
    if (list(value).some((item) => awsPrincipalMatches(String(item), ref))) return true
  }
  return false
}

function matchesPrincipal(statement: Record<string, unknown>, ref: PrincipalRef): boolean {
  if (statement.NotPrincipal !== undefined) return !principalMatches(statement.NotPrincipal, ref)
  return statement.Principal !== undefined && principalMatches(statement.Principal, ref)
}

interface Evaluation {
  /** An unconditional grant exists and no unconditional or conditional deny can undo it. */
  allowed: boolean
  /** An unconditional deny matches this action. */
  denied: boolean
  /** Only a condition could grant the action; this reader cannot evaluate it. */
  conditionalAllow: boolean
  /** A conditional deny could remove an otherwise valid grant. */
  conditionalDeny: boolean
  /** Kept for callers that only need "something is undecided". */
  conditional: boolean
  condition: string | null
}

/** Evaluate identity/resource policy statements for one action and bucket. */
export function evaluateStatements(
  documents: readonly Record<string, unknown>[],
  bucket: string,
  action: string,
  principal?: PrincipalRef,
): Evaluation {
  let allow = false
  let conditionalAllow = false
  let denied = false
  let conditionalDeny = false
  let condition: string | null = null
  for (const statement of documents) {
    if (!matchesAction(statement, action)) continue
    if (principal && !matchesPrincipal(statement, principal)) continue
    if (!matchesResource(statement, bucket, action)) continue
    const effect = String(statement.Effect ?? '')
    if (effect === 'Deny') {
      if (hasCondition(statement)) {
        conditionalDeny = true
        condition ??= conditionText(statement)
      } else denied = true
      continue
    }
    if (effect !== 'Allow') continue
    if (hasCondition(statement)) {
      conditionalAllow = true
      condition ??= conditionText(statement)
    } else {
      allow = true
    }
  }
  return {
    allowed: allow && !denied && !conditionalDeny,
    denied,
    conditionalAllow,
    conditionalDeny,
    conditional: conditionalAllow || conditionalDeny,
    condition,
  }
}

interface Details {
  users: UserDetail[]
  groups: GroupDetail[]
  roles: RoleDetail[]
  policies: ManagedPolicyDetail[]
  truncated: boolean
}

interface ScpRead {
  docs: Record<string, unknown>[]
  blind: AccessRead['blind']
  truncated: boolean
}

/**
 * One task-scoped cache. IAM details and SCPs are account-wide; reading them
 * once per bucket turns a reverse principal query into a request storm.
 */
export interface AccessSession {
  details?: Promise<Details>
  scp?: Promise<ScpRead>
  /** Requests made by the access reader, for code mode's call budget. */
  calls?: number
}

function apiCall(session: AccessSession | undefined): void {
  if (session) session.calls = (session.calls ?? 0) + 1
}

async function readDetails(
  client: IAMClient,
  signal?: AbortSignal,
  session?: AccessSession,
): Promise<Details> {
  const users: UserDetail[] = []
  const groups: GroupDetail[] = []
  const roles: RoleDetail[] = []
  const policies: ManagedPolicyDetail[] = []
  let marker: string | undefined
  let truncated = false
  for (let page = 0; page < 20; page += 1) {
    apiCall(session)
    const response = await client.send(
      new GetAccountAuthorizationDetailsCommand({ Marker: marker, MaxItems: 100 }),
      { abortSignal: signal },
    )
    users.push(...(response.UserDetailList ?? []))
    groups.push(...(response.GroupDetailList ?? []))
    roles.push(...(response.RoleDetailList ?? []))
    policies.push(...(response.Policies ?? []))
    marker = response.Marker
    truncated = Boolean(response.IsTruncated)
    if (!truncated || !marker) break
  }
  return { users, groups, roles, policies, truncated }
}

function managedDocs(
  policies: readonly ManagedPolicyDetail[],
): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>()
  for (const policy of policies) {
    if (!policy.Arn) continue
    const versions = policy.PolicyVersionList ?? []
    const version = versions.find((item) => item.IsDefaultVersion) ?? versions.at(-1)
    const docs = policyDocuments(version?.Document)
    if (docs.length) out.set(policy.Arn, docs)
  }
  return out
}

function attachedDocs(
  policyArns: readonly string[],
  documents: Map<string, Record<string, unknown>[]>,
): Record<string, unknown>[] {
  return policyArns.flatMap((arn) => documents.get(arn) ?? [])
}

function principalDocs(
  entity: UserDetail | RoleDetail,
  groups: Map<string, GroupDetail>,
  managed: Map<string, Record<string, unknown>[]>,
): {
  docs: Record<string, unknown>[]
  boundary: Record<string, unknown>[]
  missingBoundary: boolean
  missingAttached: boolean
} {
  const inline =
    'UserPolicyList' in entity
      ? entity.UserPolicyList
      : 'RolePolicyList' in entity
        ? entity.RolePolicyList
        : []
  const docs = (inline ?? []).flatMap((item) => policyDocuments(item.PolicyDocument))
  const attachedArns = (entity.AttachedManagedPolicies ?? []).flatMap((item) =>
    item.PolicyArn ? [item.PolicyArn] : [],
  )
  const attached = attachedDocs(attachedArns, managed)
  const missingAttached = attachedArns.some((arn) => !managed.has(arn))
  const groupNames = 'GroupList' in entity ? (entity.GroupList ?? []) : []
  const groupDocs: Record<string, unknown>[] = []
  let missingGroupPolicy = false
  for (const name of groupNames) {
    const group = groups.get(name)
    if (!group) {
      // IAM said the user belongs to this group, but the group's policies were
      // not in this page. The user's effective policy is therefore incomplete.
      missingGroupPolicy = true
      continue
    }
    groupDocs.push(
      ...(group.GroupPolicyList ?? []).flatMap((item) => policyDocuments(item.PolicyDocument)),
    )
    const groupArns = (group.AttachedManagedPolicies ?? []).flatMap((item) =>
      item.PolicyArn ? [item.PolicyArn] : [],
    )
    if (groupArns.some((arn) => !managed.has(arn))) missingGroupPolicy = true
    groupDocs.push(...attachedDocs(groupArns, managed))
  }
  const boundaryArn = entity.PermissionsBoundary?.PermissionsBoundaryArn
  const missingBoundary = Boolean(boundaryArn && !managed.has(boundaryArn))
  return {
    docs: [...docs, ...attached, ...groupDocs],
    boundary: boundaryArn ? (managed.get(boundaryArn) ?? []) : [],
    missingBoundary,
    missingAttached: missingAttached || missingGroupPolicy,
  }
}

function trustPaths(roles: readonly RoleDetail[], eligible: ReadonlySet<string>): AccessPath[] {
  const paths: AccessPath[] = []
  for (const role of roles) {
    if (!role.RoleName || !eligible.has(role.RoleName)) continue
    for (const statement of policyDocuments(role.AssumeRolePolicyDocument)) {
      if (String(statement.Effect ?? '') !== 'Allow') continue
      const principal = statement.Principal
      const values =
        principal && typeof principal === 'object'
          ? Object.entries(principal as Record<string, unknown>).flatMap(([kind, value]) =>
              list(value).map((item) => `${kind}:${String(item)}`),
            )
          : [String(principal ?? 'unknown')]
      const isPublic = values.some((value) => value === 'AWS:*' || value === '*')
      paths.push(
        path(
          'trust',
          `${role.RoleName} ← ${values.join(', ')}`,
          ['sts:AssumeRole'],
          conditionText(statement),
          isPublic,
          'role trust; external identity policy not evaluated',
        ),
      )
    }
  }
  return paths
}

async function scpDocuments(
  client: OrganizationsClient,
  accountId: string | undefined,
  signal?: AbortSignal,
  session?: AccessSession,
): Promise<ScpRead> {
  if (!accountId)
    return { docs: [], blind: [{ source: 'scp', status: 'unread' }], truncated: false }
  try {
    // An SCP attached to an OU or the root applies too. Walk the account's
    // parent chain instead of reading only directly attached policies.
    const targets = [accountId]
    let child = accountId
    for (let depth = 0; depth < 8; depth += 1) {
      apiCall(session)
      const parents = await client.send(new ListParentsCommand({ ChildId: child }), {
        abortSignal: signal,
      })
      const parent = parents.Parents?.[0]?.Id
      if (!parent || targets.includes(parent)) break
      targets.push(parent)
      child = parent
    }
    const policies: string[] = []
    let truncated = false
    for (const target of targets) {
      let token: string | undefined
      for (let page = 0; page < 5; page += 1) {
        apiCall(session)
        const listed = await client.send(
          new ListPoliciesForTargetCommand({
            TargetId: target,
            Filter: 'SERVICE_CONTROL_POLICY',
            NextToken: token,
          }),
          { abortSignal: signal },
        )
        for (const policy of listed.Policies ?? []) if (policy.Id) policies.push(policy.Id)
        token = listed.NextToken
        if (!token) break
        if (page === 4) truncated = true
      }
    }
    const unique = [...new Set(policies)]
    if (unique.length > 100) truncated = true
    const docs = []
    for (const id of unique.slice(0, 100)) {
      apiCall(session)
      const policy = await client.send(new DescribePolicyCommand({ PolicyId: id }), {
        abortSignal: signal,
      })
      docs.push(...policyDocuments(policy.Policy?.Content))
    }
    return { docs, blind: [], truncated }
  } catch (error) {
    if (isAbort(error)) throw error
    return { docs: [], blind: [{ source: 'scp', status: classify(error) }], truncated: false }
  }
}

async function iamPaths(
  client: IAMClient,
  bucket: string,
  scp: readonly Record<string, unknown>[],
  resourcePolicy: readonly Record<string, unknown>[],
  accountId: string | undefined,
  signal?: AbortSignal,
  session?: AccessSession,
): Promise<{ paths: AccessPath[]; blind: AccessRead['blind']; coverage: AccessCoverage }> {
  try {
    const detailsPromise = session?.details ?? readDetails(client, signal, session)
    if (session && !session.details) session.details = detailsPromise
    const details = await detailsPromise
    const managed = managedDocs(details.policies)
    const groups = new Map<string, GroupDetail>()
    for (const group of details.groups) if (group.GroupName) groups.set(group.GroupName, group)
    const paths: AccessPath[] = []
    const eligibleRoles = new Set<string>()
    let undecided = 0
    let evaluated = 0
    const entities: (UserDetail | RoleDetail)[] = [...details.users, ...details.roles]
    for (const entity of entities) {
      const name =
        'UserName' in entity ? entity.UserName : 'RoleName' in entity ? entity.RoleName : undefined
      if (!name) continue
      const { docs, boundary, missingBoundary, missingAttached } = principalDocs(
        entity,
        groups,
        managed,
      )
      const kind: PrincipalRef['kind'] = 'UserName' in entity ? 'user' : 'role'
      const principalRef: PrincipalRef = {
        kind,
        name,
        ...('Arn' in entity && entity.Arn ? { arn: entity.Arn } : {}),
        ...(accountId ? { accountId } : {}),
      }
      if (missingBoundary || missingAttached) undecided += 1
      const allowed: string[] = []
      let conditional = false
      let condition: string | null = null
      for (const action of IAM_ACTIONS) {
        const result = evaluateStatements(docs, bucket, action)
        // A resource-policy Deny applies to the identity grant as well. A
        // conditional Deny cannot be turned into a clean allow.
        const resource = resourcePolicy.length
          ? evaluateStatements(resourcePolicy, bucket, action, principalRef)
          : null
        if (result.denied || resource?.denied) continue
        if (result.conditionalDeny || resource?.conditionalDeny) {
          conditional = true
          condition ??= result.condition ?? resource?.condition ?? null
          continue
        }
        // SCPs are an account-wide intersection too. They must allow the
        // action; a conditional allow or deny is undecided, not clean.
        if (scp.length) {
          const limit = evaluateStatements(scp, bucket, action)
          if (limit.denied || limit.conditionalDeny) {
            if (limit.conditionalDeny) {
              conditional = true
              condition ??= limit.condition
            }
            continue
          }
          if (!limit.allowed) {
            if (limit.conditionalAllow) {
              conditional = true
              condition ??= limit.condition
            }
            continue
          }
        }
        // A permissions boundary is an intersection, not another Allow.
        if (boundary.length) {
          const limit = evaluateStatements(boundary, bucket, action)
          if (limit.denied || limit.conditionalDeny) {
            if (limit.conditionalDeny) {
              conditional = true
              condition ??= limit.condition
            }
            continue
          }
          if (!limit.allowed) {
            if (limit.conditionalAllow) {
              conditional = true
              condition ??= limit.condition
            }
            continue
          }
        }
        if (result.allowed) allowed.push(action)
        else if (result.conditionalAllow) {
          conditional = true
          condition ??= result.condition
        }
      }
      evaluated += 1
      if (allowed.length)
        paths.push(
          path(
            'iam',
            name,
            allowed,
            null,
            false,
            missingBoundary || missingAttached
              ? 'an attached policy or boundary could not be read'
              : 'identity policy',
          ),
        )
      else if (conditional)
        paths.push(
          path('iam', name, ['conditionally allowed'], condition, false, 'condition not evaluated'),
        )
      if (conditional) undecided += 1
      if ((allowed.length || conditional) && 'RoleName' in entity && entity.RoleName)
        eligibleRoles.add(entity.RoleName)
    }
    paths.push(...trustPaths(details.roles, eligibleRoles))
    return {
      paths,
      blind: details.truncated ? [{ source: 'iam', status: 'truncated' as ReadStatus }] : [],
      coverage: {
        principals: entities.length,
        evaluated,
        undecided,
        truncated: details.truncated,
        sources: ['iam', 'identity policies', 'groups', 'managed policies', 'role trust'],
      },
    }
  } catch (error) {
    if (isAbort(error)) throw error
    return {
      paths: [],
      blind: [{ source: 'iam', status: classify(error) }],
      coverage: { principals: 0, evaluated: 0, undecided: 0, truncated: false, sources: [] },
    }
  }
}

function externalPolicyPrincipal(principal: string, accountId: string | undefined): boolean {
  if (!accountId || principal === '*' || principal.includes('*')) return false
  const accounts: string[] = principal.match(/\b\d{12}\b/g) ?? []
  return accounts.length > 0 && !accounts.includes(accountId)
}

function fromPolicy(facts: BucketFacts): AccessPath[] {
  const policy = facts.policy.value
  if (!policy) return []
  const blocked =
    facts.pab.value?.restrictPublicBuckets === true ||
    facts.account.pab.value?.restrictPublicBuckets === true
  return policy.statements.map((statement) => {
    const notes: string[] = []
    if (blocked && statement.public) notes.push('blocked by public access block')
    if (externalPolicyPrincipal(statement.principal, facts.account.accountId))
      notes.push('external identity policy not read')
    return path(
      'policy',
      statement.principal,
      statement.actions,
      statement.condition,
      blocked ? false : statement.public,
      notes.length ? notes.join('; ') : null,
    )
  })
}

function aclActions(acl: { read: boolean; write: boolean }): string[] {
  const actions = [...(acl.read ? ['read'] : []), ...(acl.write ? ['write'] : [])]
  // READ_ACP or WRITE_ACP alone does not grant object data, but it is still a
  // grant on the bucket and must not disappear from the answer.
  return actions.length ? actions : ['ACL']
}

function fromAcl(facts: BucketFacts, restricted: boolean): AccessPath[] {
  const acl = facts.acl.value
  if (!acl) return []
  const note = restricted ? 'ignored by public access block' : null
  const paths: AccessPath[] = []
  if (acl.allUsers)
    paths.push(
      path(
        'acl',
        'AllUsers',
        aclActions({
          read: acl.allUsersRead ?? acl.read ?? true,
          write: acl.allUsersWrite ?? acl.write,
        }),
        null,
        !restricted,
        note,
      ),
    )
  if (acl.authenticatedUsers)
    paths.push(
      path(
        'acl',
        'AuthenticatedUsers',
        aclActions({
          read: acl.authenticatedUsersRead ?? acl.read ?? true,
          write: acl.authenticatedUsersWrite ?? acl.write,
        }),
        null,
        false,
        note,
      ),
    )
  return paths
}

async function kmsPaths(
  client: KMSClient,
  keyArn: string,
  signal?: AbortSignal,
  session?: AccessSession,
): Promise<{ paths: AccessPath[]; blind: AccessRead['blind'] }> {
  try {
    apiCall(session)
    const described = await client.send(new DescribeKeyCommand({ KeyId: keyArn }), {
      abortSignal: signal,
    })
    const arn = described.KeyMetadata?.Arn ?? keyArn
    apiCall(session)
    const policy = await client.send(
      new GetKeyPolicyCommand({ KeyId: arn, PolicyName: 'default' }),
      { abortSignal: signal },
    )
    const facts = evaluatePolicy(policy.Policy)
    return {
      paths: facts.statements.map((statement) =>
        path(
          'kms',
          statement.principal,
          ['kms:Decrypt', ...statement.actions],
          statement.condition,
          statement.public,
          'key policy',
        ),
      ),
      blind: [],
    }
  } catch (error) {
    if (isAbort(error)) throw error
    return { paths: [], blind: [{ source: 'kms', status: classify(error) }] }
  }
}

async function analyzerPaths(
  client: AccessAnalyzerClient,
  bucket: string,
  signal?: AbortSignal,
  session?: AccessSession,
): Promise<{ paths: AccessPath[]; blind: AccessRead['blind']; truncated: boolean }> {
  try {
    const analyzers = []
    let analyzerToken: string | undefined
    let truncated = false
    for (let page = 0; page < 5; page += 1) {
      apiCall(session)
      const listed = await client.send(
        new ListAnalyzersCommand({ type: 'ACCOUNT', nextToken: analyzerToken }),
        { abortSignal: signal },
      )
      analyzers.push(...(listed.analyzers ?? []))
      analyzerToken = listed.nextToken
      if (!analyzerToken) break
      if (page === 4) truncated = true
    }
    const paths: AccessPath[] = []
    for (const analyzer of analyzers) {
      if (!analyzer.arn) continue
      let token: string | undefined
      for (let findingPage = 0; findingPage < 5; findingPage += 1) {
        apiCall(session)
        const findings = await client.send(
          new ListFindingsCommand({
            analyzerArn: analyzer.arn,
            filter: { resource: { eq: [`arn:aws:s3:::${bucket}`] } },
            maxResults: 100,
            nextToken: token,
          }),
          { abortSignal: signal },
        )
        for (const finding of findings.findings ?? []) {
          const action = finding.action?.join(', ') ?? 'access'
          const principal = finding.principal
            ? Object.entries(finding.principal)
                .map(([kind, value]) => `${kind}:${String(value)}`)
                .join(', ')
            : 'unknown'
          paths.push(
            path(
              'access-analyzer',
              principal,
              [action],
              finding.condition ? JSON.stringify(finding.condition).slice(0, 180) : null,
              finding.isPublic === true,
              finding.isPublic ? 'public finding' : 'external access',
            ),
          )
        }
        token = findings.nextToken
        if (!token) break
        if (findingPage === 4) truncated = true
      }
    }
    return { paths, blind: [], truncated }
  } catch (error) {
    if (isAbort(error)) throw error
    return {
      paths: [],
      blind: [{ source: 'access-analyzer', status: classify(error) }],
      truncated: false,
    }
  }
}

export async function readAccess(input: {
  bucket: string
  facts: BucketFacts
  aws: boolean
  iam?: IAMClient
  kms?: KMSClient
  analyzer?: AccessAnalyzerClient
  organizations?: OrganizationsClient
  signal?: AbortSignal
  /** Reuse IAM and SCP reads across buckets in one task. */
  session?: AccessSession
}): Promise<AccessRead> {
  const session: AccessSession = input.session ?? {}
  const paths = [...fromPolicy(input.facts)]
  // Either the bucket or the account block can make a public ACL ineffective.
  const blockedAcl =
    input.facts.pab.value?.ignorePublicAcls === true ||
    input.facts.account.pab.value?.ignorePublicAcls === true
  paths.push(...fromAcl(input.facts, blockedAcl))
  const blind: AccessRead['blind'] = []
  // A resource policy can name a principal in another account. Its identity
  // policy is outside this reader, so the grant is evidence, not a decision.
  if (
    paths.some(
      (item) =>
        item.source === 'policy' && item.note?.includes('external identity policy not read'),
    )
  )
    blind.push({ source: 'external identity policy', status: 'unread' })
  const bucketPab = input.facts.pab
  if (bucketPab.status !== 'available' && bucketPab.status !== 'not_configured')
    blind.push({ source: 'pab', status: bucketPab.status })
  if (input.aws) {
    const accountPab = input.facts.account.pab
    if (accountPab.status !== 'available' && accountPab.status !== 'not_configured')
      blind.push({ source: 'account public access block', status: accountPab.status })
    if (!input.iam) blind.push({ source: 'iam', status: 'unread' })
    if (
      input.facts.encryption.status !== 'available' &&
      input.facts.encryption.status !== 'not_configured'
    )
      blind.push({ source: 'encryption', status: input.facts.encryption.status })
    if (input.facts.encryption.value?.keyArn && !input.kms)
      blind.push({ source: 'kms', status: 'unread' })
  }
  if (
    input.facts.policy.status === 'access_denied' ||
    input.facts.policy.status === 'error' ||
    input.facts.policy.status === 'provider_unsupported'
  )
    blind.push({ source: 'policy', status: input.facts.policy.status })
  if (
    input.facts.acl.status === 'access_denied' ||
    input.facts.acl.status === 'error' ||
    input.facts.acl.status === 'provider_unsupported'
  )
    blind.push({ source: 'acl', status: input.facts.acl.status })
  let coverage: AccessCoverage = {
    principals: 0,
    evaluated: 0,
    undecided: 0,
    truncated: input.facts.policy.value?.statementsTruncated === true,
    sources: ['bucket policy', 'ACL'],
  }
  if (input.aws) {
    const scpPromise = input.organizations
      ? (session.scp ??
        scpDocuments(input.organizations, input.facts.account.accountId, input.signal, session))
      : Promise.resolve({
          docs: [],
          blind: [{ source: 'scp', status: 'unread' as ReadStatus }],
          truncated: false,
        })
    if (input.organizations && !session.scp) session.scp = scpPromise
    const scp = await scpPromise
    const results = await Promise.all([
      input.kms && input.facts.encryption.value?.keyArn
        ? kmsPaths(input.kms, input.facts.encryption.value.keyArn, input.signal, session)
        : Promise.resolve({ paths: [], blind: [] }),
      input.analyzer
        ? analyzerPaths(input.analyzer, input.bucket, input.signal, session)
        : Promise.resolve({ paths: [], blind: [], truncated: false }),
      input.iam
        ? iamPaths(
            input.iam,
            input.bucket,
            scp.docs,
            input.facts.policy.value?.documents ?? [],
            input.facts.account.accountId,
            input.signal,
            session,
          )
        : Promise.resolve({
            paths: [],
            blind: [],
            coverage: {
              principals: 0,
              evaluated: 0,
              undecided: 0,
              truncated: false,
              sources: [],
            },
          }),
    ])
    for (const result of results) {
      paths.push(...result.paths)
      blind.push(...result.blind)
    }
    blind.push(...scp.blind)
    const iam = results[2] as Awaited<ReturnType<typeof iamPaths>>
    coverage = {
      ...iam.coverage,
      undecided: iam.coverage.undecided + scp.blind.length,
      truncated:
        coverage.truncated ||
        iam.coverage.truncated ||
        scp.truncated ||
        Boolean((results[1] as { truncated?: boolean }).truncated),
      sources: [...coverage.sources, ...iam.coverage.sources, 'SCP'],
    }
  }
  const limited = paths.slice(0, 120)
  if (limited.length < paths.length) coverage.truncated = true
  return { paths: limited, blind, coverage, calls: session.calls ?? 0 }
}
