import {
  GetBucketAclCommand,
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLoggingCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketPolicyStatusCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { type ReadStatus, read } from './status'

export type FindingSeverity = 'high' | 'medium' | 'low' | 'ok'

export interface Finding {
  severity: FindingSeverity
  title: string
  detail: string
}

const ALL_USERS = 'http://acs.amazonaws.com/groups/global/AllUsers'
const AUTH_USERS = 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers'

function finding(severity: FindingSeverity, title: string, detail: string): Finding {
  return { severity, title, detail }
}

function unsupported(status: ReadStatus, item: string): Finding[] {
  if (status === 'provider_unsupported') {
    return [
      finding(
        'low',
        `${item} not supported`,
        'The provider does not implement this configuration API.',
      ),
    ]
  }
  if (status === 'access_denied') {
    return [
      finding(
        'medium',
        `Access denied reading ${item}`,
        'These credentials cannot read this configuration, so this aspect is unassessed.',
      ),
    ]
  }
  if (status === 'error') {
    return [
      finding(
        'medium',
        `Could not read ${item}`,
        'An unexpected error left this aspect unassessed.',
      ),
    ]
  }
  return []
}

interface PolicyFacts {
  publicPrincipal: boolean
  anonymousGetObject: boolean
  anonymousListBucket: boolean
}

function policyFacts(policy: string | undefined): PolicyFacts {
  const facts: PolicyFacts = {
    publicPrincipal: false,
    anonymousGetObject: false,
    anonymousListBucket: false,
  }
  if (!policy) return facts
  let doc: { Statement?: unknown }
  try {
    doc = JSON.parse(policy)
  } catch {
    return facts
  }
  const statements = Array.isArray(doc.Statement)
    ? doc.Statement
    : doc.Statement
      ? [doc.Statement]
      : []
  for (const raw of statements) {
    const stmt = raw as Record<string, unknown>
    if (stmt.Effect !== 'Allow') continue
    const principal = stmt.Principal
    let isPublic = false
    if (principal && typeof principal === 'object') {
      const aws = (principal as Record<string, unknown>).AWS
      const values = Array.isArray(aws) ? aws : aws ? [aws] : []
      isPublic = values.some((v) => v === '*')
    } else {
      isPublic = principal === '*'
    }
    if (!isPublic) continue
    facts.publicPrincipal = true
    const actions = stmt.Action
    const list = (Array.isArray(actions) ? actions : actions ? [actions] : []).map((a) =>
      String(a).toLowerCase(),
    )
    if (list.some((a) => a === 's3:getobject' || a === 's3:*' || a === '*')) {
      facts.anonymousGetObject = true
    }
    if (list.some((a) => a === 's3:listbucket' || a === 's3:*' || a === '*')) {
      facts.anonymousListBucket = true
    }
  }
  return facts
}

export async function reviewSecurity(client: S3Client, bucket: string): Promise<Finding[]> {
  const [policy, cors, encryption, acl, pab, policyStatus, ownership] = await Promise.all([
    read(() => client.send(new GetBucketPolicyCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketCorsCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketEncryptionCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketAclCommand({ Bucket: bucket }))),
    read(() => client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketPolicyStatusCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket }))),
  ])

  const findings: Finding[] = []
  const facts = policyFacts(policy.data?.Policy)
  if (facts.publicPrincipal) {
    findings.push(
      finding(
        'medium',
        'Bucket policy allows a wildcard principal',
        "A statement allows Principal '*'. Confirm this is intentional.",
      ),
    )
  }
  if (facts.anonymousGetObject) {
    findings.push(
      finding(
        'high',
        'Anonymous s3:GetObject allowed',
        'The policy permits unauthenticated object reads.',
      ),
    )
  }
  if (facts.anonymousListBucket) {
    findings.push(
      finding(
        'high',
        'Anonymous s3:ListBucket allowed',
        'The policy permits unauthenticated bucket listing.',
      ),
    )
  }
  if (policy.status === 'not_configured' && !facts.publicPrincipal) {
    findings.push(
      finding('ok', 'No bucket policy granting public access', 'No bucket policy is set.'),
    )
  }
  findings.push(...unsupported(policy.status, 'bucket policy'))

  let corsWildcard = false
  if (cors.status === 'available') {
    corsWildcard = (cors.data?.CORSRules ?? []).some((rule) =>
      (rule.AllowedOrigins ?? []).includes('*'),
    )
    if (corsWildcard) {
      findings.push(
        finding('medium', 'CORS allows all origins', "A CORS rule uses AllowedOrigins ['*']."),
      )
    }
  }
  findings.push(...unsupported(cors.status, 'CORS'))

  if (encryption.status === 'available') {
    findings.push(
      finding('ok', 'Default encryption enabled', 'Server-side default encryption is configured.'),
    )
  } else if (encryption.status === 'not_configured') {
    findings.push(
      finding(
        'medium',
        'No default encryption',
        'The bucket has no default server-side encryption.',
      ),
    )
  }
  findings.push(...unsupported(encryption.status, 'encryption'))

  const aclPublic =
    acl.status === 'available' &&
    (acl.data?.Grants ?? []).some(
      (grant) => grant.Grantee?.URI === ALL_USERS || grant.Grantee?.URI === AUTH_USERS,
    )
  if (aclPublic) {
    findings.push(
      finding(
        'high',
        'ACL grants public access',
        'The bucket ACL grants access to AllUsers or AuthenticatedUsers.',
      ),
    )
  }
  findings.push(...unsupported(acl.status, 'ACL'))

  if (pab.status === 'available') {
    const cfg = pab.data?.PublicAccessBlockConfiguration
    const all = Boolean(
      cfg?.BlockPublicAcls &&
        cfg?.IgnorePublicAcls &&
        cfg?.BlockPublicPolicy &&
        cfg?.RestrictPublicBuckets,
    )
    findings.push(
      all
        ? finding(
            'ok',
            'Public access fully blocked',
            'All public access block settings are enabled.',
          )
        : finding(
            'medium',
            'Public access block incomplete',
            'Not all public access block settings are enabled.',
          ),
    )
  } else if (pab.status === 'not_configured') {
    findings.push(
      finding(
        'medium',
        'Public access block not configured',
        'No public access block configuration is set.',
      ),
    )
  }
  findings.push(...unsupported(pab.status, 'public access block'))

  let policyIsPublic: boolean | null = null
  if (policyStatus.status === 'available') {
    policyIsPublic = Boolean(policyStatus.data?.PolicyStatus?.IsPublic)
    if (policyIsPublic) {
      findings.push(
        finding(
          'high',
          'Bucket policy makes this bucket PUBLIC (AWS verdict)',
          'GetBucketPolicyStatus reports the policy grants public access.',
        ),
      )
    }
  } else if (policyStatus.status === 'not_configured') {
    policyIsPublic = false
  }
  findings.push(...unsupported(policyStatus.status, 'policy status'))

  if (policyIsPublic === true || aclPublic) {
    // already reported by the specific finding
  } else if (
    policyIsPublic === false &&
    (acl.status === 'available' ||
      acl.status === 'not_configured' ||
      acl.status === 'skipped_acls_disabled')
  ) {
    findings.push(
      finding(
        'ok',
        'Not public (policy verdict + ACL check)',
        'The policy is not public and the ACL grants no public access.',
      ),
    )
  } else if (policyIsPublic === false) {
    findings.push(
      finding(
        'medium',
        'Policy not public, but ACL unreadable',
        'Public exposure through ACL grants cannot be ruled out.',
      ),
    )
  }

  const ownershipMode = ownership.data?.OwnershipControls?.Rules?.[0]?.ObjectOwnership
  if (ownership.status === 'available') {
    if (ownershipMode === 'BucketOwnerEnforced') {
      findings.push(
        finding(
          'ok',
          'ACLs disabled (BucketOwnerEnforced)',
          'ACLs are disabled, the recommended posture.',
        ),
      )
    } else if (ownershipMode) {
      findings.push(
        finding(
          'low',
          'ACLs still active',
          `Object Ownership is ${ownershipMode}; consider BucketOwnerEnforced.`,
        ),
      )
    }
  }
  findings.push(...unsupported(ownership.status, 'object ownership'))

  return findings
}

export async function reviewLifecycle(client: S3Client, bucket: string): Promise<Finding[]> {
  const [lifecycle, versioning] = await Promise.all([
    read(() => client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketVersioningCommand({ Bucket: bucket }))),
  ])
  const findings: Finding[] = []
  const rules = lifecycle.data?.Rules ?? []
  const hasAbort = rules.some((r) => Boolean(r.AbortIncompleteMultipartUpload))
  const hasExpiration = rules.some((r) => Boolean(r.Expiration))
  const hasTransition = rules.some((r) => Boolean(r.Transitions?.length))
  const hasNoncurrent = rules.some((r) => Boolean(r.NoncurrentVersionExpiration))
  const versioningOn = versioning.status === 'available' && versioning.data?.Status === 'Enabled'

  if (lifecycle.status === 'not_configured') {
    findings.push(
      finding(
        'low',
        'No lifecycle configuration',
        'Consider lifecycle rules for expiration, transitions and cleanup.',
      ),
    )
  } else if (lifecycle.status === 'available') {
    if (!hasAbort) {
      findings.push(
        finding(
          'medium',
          'No AbortIncompleteMultipartUpload rule',
          'Incomplete multipart uploads can accumulate cost without cleanup.',
        ),
      )
    }
    if (!hasExpiration) {
      findings.push(
        finding('low', 'No expiration rules', 'No object expiration rules are configured.'),
      )
    }
    if (!hasTransition) {
      findings.push(
        finding('low', 'No transition rules', 'No storage-class transition rules are configured.'),
      )
    }
    if (versioningOn && !hasNoncurrent) {
      findings.push(
        finding(
          'medium',
          'Versioning enabled without noncurrent cleanup',
          'Noncurrent versions are never expired; they will accumulate.',
        ),
      )
    }
    if (hasAbort && hasExpiration) {
      findings.push(
        finding(
          'ok',
          'Lifecycle covers cleanup and expiration',
          'Lifecycle rules look reasonable.',
        ),
      )
    }
  }
  findings.push(...unsupported(lifecycle.status, 'lifecycle'))
  findings.push(...unsupported(versioning.status, 'versioning'))
  return findings
}

export async function reviewObservability(client: S3Client, bucket: string): Promise<Finding[]> {
  const [logging, tagging, notifications] = await Promise.all([
    read(() => client.send(new GetBucketLoggingCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketTaggingCommand({ Bucket: bucket }))),
    read(() => client.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket }))),
  ])
  const findings: Finding[] = []
  if (logging.status === 'available') {
    findings.push(
      logging.data?.LoggingEnabled
        ? finding('ok', 'Server access logging enabled', 'Access logging is configured.')
        : finding(
            'low',
            'Server access logging not enabled',
            'Enable access logging for audit and analysis.',
          ),
    )
  }
  findings.push(...unsupported(logging.status, 'logging'))

  if (notifications.status === 'available') {
    const data = notifications.data
    const configured = Boolean(
      data?.TopicConfigurations?.length ||
        data?.QueueConfigurations?.length ||
        data?.LambdaFunctionConfigurations?.length ||
        data?.EventBridgeConfiguration,
    )
    if (!configured)
      findings.push(
        finding('ok', 'No event notifications', 'No notification targets are configured.'),
      )
  }
  findings.push(...unsupported(notifications.status, 'notification'))

  const hasTags = tagging.status === 'available' && Boolean(tagging.data?.TagSet?.length)
  if (tagging.status === 'available' && !hasTags) {
    findings.push(
      finding('low', 'No bucket tags', 'Tags help with cost attribution and ownership.'),
    )
  }
  findings.push(...unsupported(tagging.status, 'tagging'))
  return findings
}
