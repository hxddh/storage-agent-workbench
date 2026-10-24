/**
 * Who can reach a bucket.
 *
 * This is evidence, not an authorization decision. Policy statements are read
 * locally; IAM identity policies are simulated in bounded batches; a KMS key
 * policy is read only when the bucket uses SSE-KMS; Access Analyzer findings
 * are attached when the account has an analyzer. A read that is denied is a
 * blind spot, never an empty access list.
 */
import {
  type AccessAnalyzerClient,
  ListAnalyzersCommand,
  ListFindingsCommand,
} from '@aws-sdk/client-accessanalyzer'
import {
  type IAMClient,
  ListRolesCommand,
  ListUsersCommand,
  SimulatePrincipalPolicyCommand,
} from '@aws-sdk/client-iam'
import { DescribeKeyCommand, GetKeyPolicyCommand, type KMSClient } from '@aws-sdk/client-kms'
import type { AccessPath } from '@shared/contract'
import type { BucketFacts } from './facts'
import { evaluatePolicy } from './policy'
import { classify, isAbort, type ReadStatus } from './status'

export interface AccessRead {
  paths: AccessPath[]
  blind: { source: string; status: ReadStatus }[]
}

const IAM_ACTIONS = ['s3:GetObject', 's3:ListBucket', 's3:PutObject']

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
    actions: [...new Set(actions)].slice(0, 12),
    condition,
    public: isPublic,
    note,
  }
}

function fromPolicy(facts: BucketFacts): AccessPath[] {
  const policy = facts.policy.value
  if (!policy) return []
  return policy.statements.map((statement) =>
    path(
      'policy',
      statement.principal,
      statement.actions,
      statement.condition,
      statement.public,
      null,
    ),
  )
}

function fromAcl(facts: BucketFacts, restricted: boolean): AccessPath[] {
  const acl = facts.acl.value
  if (!acl) return []
  const paths: AccessPath[] = []
  if (acl.allUsers)
    paths.push(
      path('acl', 'AllUsers', [...(acl.write ? ['write'] : []), 'read'], null, !restricted),
    )
  if (acl.authenticatedUsers) paths.push(path('acl', 'AuthenticatedUsers', ['read'], null, false))
  return paths
}

async function kmsPaths(
  client: KMSClient,
  keyArn: string,
  signal?: AbortSignal,
): Promise<{ paths: AccessPath[]; blind: AccessRead['blind'] }> {
  try {
    const described = await client.send(new DescribeKeyCommand({ KeyId: keyArn }), {
      abortSignal: signal,
    })
    const arn = described.KeyMetadata?.Arn ?? keyArn
    const policy = await client.send(
      new GetKeyPolicyCommand({ KeyId: arn, PolicyName: 'default' }),
      {
        abortSignal: signal,
      },
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
): Promise<{ paths: AccessPath[]; blind: AccessRead['blind'] }> {
  try {
    const analyzers = await client.send(new ListAnalyzersCommand({ type: 'ACCOUNT' }), {
      abortSignal: signal,
    })
    const paths: AccessPath[] = []
    for (const analyzer of (analyzers.analyzers ?? []).slice(0, 2)) {
      if (!analyzer.arn) continue
      const findings = await client.send(
        new ListFindingsCommand({
          analyzerArn: analyzer.arn,
          filter: { resource: { eq: [`arn:aws:s3:::${bucket}`] } },
          maxResults: 20,
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
    }
    return { paths, blind: [] }
  } catch (error) {
    if (isAbort(error)) throw error
    return { paths: [], blind: [{ source: 'access-analyzer', status: classify(error) }] }
  }
}

async function iamPaths(
  client: IAMClient,
  bucket: string,
  signal?: AbortSignal,
): Promise<{ paths: AccessPath[]; blind: AccessRead['blind'] }> {
  try {
    const [users, roles] = await Promise.all([
      client.send(new ListUsersCommand({ MaxItems: 20 }), { abortSignal: signal }),
      client.send(new ListRolesCommand({ MaxItems: 20 }), { abortSignal: signal }),
    ])
    const principals = [
      ...(users.Users ?? []).map((user) => ({ arn: user.Arn, name: user.UserName })),
      ...(roles.Roles ?? []).map((role) => ({ arn: role.Arn, name: role.RoleName })),
    ].filter((item): item is { arn: string; name: string } => Boolean(item.arn && item.name))
    const paths: AccessPath[] = []
    for (const principal of principals.slice(0, 5)) {
      const simulation = await client.send(
        new SimulatePrincipalPolicyCommand({
          PolicySourceArn: principal.arn,
          ActionNames: IAM_ACTIONS,
          ResourceArns: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        }),
        { abortSignal: signal },
      )
      const allowed = (simulation.EvaluationResults ?? [])
        .filter((result) => result.EvalDecision === 'allowed')
        .map((result) => result.EvalActionName ?? '')
        .filter(Boolean)
      if (allowed.length)
        paths.push(path('iam', principal.name, allowed, null, false, 'identity policy'))
    }
    return { paths, blind: [] }
  } catch (error) {
    if (isAbort(error)) throw error
    return { paths: [], blind: [{ source: 'iam', status: classify(error) }] }
  }
}

export async function readAccess(input: {
  bucket: string
  facts: BucketFacts
  aws: boolean
  iam?: IAMClient
  kms?: KMSClient
  analyzer?: AccessAnalyzerClient
  signal?: AbortSignal
}): Promise<AccessRead> {
  const paths = [...fromPolicy(input.facts)]
  const blockedAcl = input.facts.pab.value?.ignorePublicAcls === true
  for (const item of fromAcl(input.facts, blockedAcl)) {
    if (item.public) item.note = blockedAcl ? 'blocked by public access block' : null
    paths.push(item)
  }
  const blind: AccessRead['blind'] = []
  if (input.facts.policy.status === 'access_denied' || input.facts.policy.status === 'error')
    blind.push({ source: 'policy', status: input.facts.policy.status })
  if (input.facts.acl.status === 'access_denied' || input.facts.acl.status === 'error')
    blind.push({ source: 'acl', status: input.facts.acl.status })
  if (input.aws) {
    const results = await Promise.all([
      input.kms && input.facts.encryption.value?.keyArn
        ? kmsPaths(input.kms, input.facts.encryption.value.keyArn, input.signal)
        : Promise.resolve({ paths: [], blind: [] }),
      input.analyzer
        ? analyzerPaths(input.analyzer, input.bucket, input.signal)
        : Promise.resolve({ paths: [], blind: [] }),
      input.iam
        ? iamPaths(input.iam, input.bucket, input.signal)
        : Promise.resolve({ paths: [], blind: [] }),
    ])
    for (const result of results) {
      paths.push(...result.paths)
      blind.push(...result.blind)
    }
  }
  return { paths: paths.slice(0, 120), blind }
}
