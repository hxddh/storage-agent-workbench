/**
 * Approved changes.
 *
 * The agent proposes one write; the user approves it in the window; the app
 * runs exactly that call. The model never holds a write-capable client and
 * never sees anything that could approve. Only reversible bucket
 * configuration can be changed, and before a proposal is shown the app reads
 * the current state, so every applied change can be rolled back.
 */
import { randomUUID } from 'node:crypto'
import type { ProviderConfig, Providers } from './providers'
import { checkInput, MODULES, shape } from './s3/api'
import { ScopeError } from './security/scope'

/** One allowed write: the read that captures what it replaces, and how to put that back. */
interface Writable {
  /** The read of the current state. */
  read: string
  /** Errors of that read that mean "nothing is set". */
  absent: RegExp
  /** The call that restores a snapshot; `null` snapshot means nothing was set before. */
  inverse(
    snapshot: Record<string, unknown> | null,
    input: Record<string, unknown>,
  ): {
    operation: string
    input: Record<string, unknown>
  }
}

const bucketOf = (input: Record<string, unknown>) => ({ Bucket: input.Bucket })

/** Put the old value back, or delete what did not exist before. */
const putOrDelete =
  (put: string, del: string, field: string, from: (snapshot: Record<string, unknown>) => unknown) =>
  (snapshot: Record<string, unknown> | null, input: Record<string, unknown>) =>
    snapshot
      ? { operation: put, input: { ...bucketOf(input), [field]: from(snapshot) } }
      : { operation: del, input: bucketOf(input) }

export const WRITABLE: Record<string, Writable> = {
  's3:PutPublicAccessBlock': {
    read: 'GetPublicAccessBlock',
    absent: /NoSuchPublicAccessBlockConfiguration/,
    inverse: putOrDelete(
      'PutPublicAccessBlock',
      'DeletePublicAccessBlock',
      'PublicAccessBlockConfiguration',
      (s) => s.PublicAccessBlockConfiguration,
    ),
  },
  's3:DeletePublicAccessBlock': {
    read: 'GetPublicAccessBlock',
    absent: /NoSuchPublicAccessBlockConfiguration/,
    inverse: putOrDelete(
      'PutPublicAccessBlock',
      'DeletePublicAccessBlock',
      'PublicAccessBlockConfiguration',
      (s) => s.PublicAccessBlockConfiguration,
    ),
  },
  's3:PutBucketPolicy': {
    read: 'GetBucketPolicy',
    absent: /NoSuchBucketPolicy/,
    inverse: putOrDelete('PutBucketPolicy', 'DeleteBucketPolicy', 'Policy', (s) => s.Policy),
  },
  's3:DeleteBucketPolicy': {
    read: 'GetBucketPolicy',
    absent: /NoSuchBucketPolicy/,
    inverse: putOrDelete('PutBucketPolicy', 'DeleteBucketPolicy', 'Policy', (s) => s.Policy),
  },
  's3:PutBucketOwnershipControls': {
    read: 'GetBucketOwnershipControls',
    absent: /OwnershipControlsNotFoundError/,
    inverse: putOrDelete(
      'PutBucketOwnershipControls',
      'DeleteBucketOwnershipControls',
      'OwnershipControls',
      (s) => s.OwnershipControls,
    ),
  },
  's3:PutBucketEncryption': {
    read: 'GetBucketEncryption',
    absent: /ServerSideEncryptionConfigurationNotFoundError/,
    inverse: putOrDelete(
      'PutBucketEncryption',
      'DeleteBucketEncryption',
      'ServerSideEncryptionConfiguration',
      (s) => s.ServerSideEncryptionConfiguration,
    ),
  },
  's3:PutBucketVersioning': {
    read: 'GetBucketVersioning',
    absent: /^$/,
    // Versioning never goes back to "never enabled"; the closest is Suspended.
    inverse: (snapshot, input) => ({
      operation: 'PutBucketVersioning',
      input: {
        ...bucketOf(input),
        VersioningConfiguration: { Status: (snapshot?.Status as string) || 'Suspended' },
      },
    }),
  },
  's3:PutBucketLifecycleConfiguration': {
    read: 'GetBucketLifecycleConfiguration',
    absent: /NoSuchLifecycleConfiguration/,
    inverse: putOrDelete(
      'PutBucketLifecycleConfiguration',
      'DeleteBucketLifecycle',
      'LifecycleConfiguration',
      (s) => ({ Rules: s.Rules }),
    ),
  },
  's3:DeleteBucketLifecycle': {
    read: 'GetBucketLifecycleConfiguration',
    absent: /NoSuchLifecycleConfiguration/,
    inverse: putOrDelete(
      'PutBucketLifecycleConfiguration',
      'DeleteBucketLifecycle',
      'LifecycleConfiguration',
      (s) => ({ Rules: s.Rules }),
    ),
  },
  's3:PutBucketCors': {
    read: 'GetBucketCors',
    absent: /NoSuchCORSConfiguration/,
    inverse: putOrDelete('PutBucketCors', 'DeleteBucketCors', 'CORSConfiguration', (s) => ({
      CORSRules: s.CORSRules,
    })),
  },
  's3:DeleteBucketCors': {
    read: 'GetBucketCors',
    absent: /NoSuchCORSConfiguration/,
    inverse: putOrDelete('PutBucketCors', 'DeleteBucketCors', 'CORSConfiguration', (s) => ({
      CORSRules: s.CORSRules,
    })),
  },
  's3:PutBucketLogging': {
    read: 'GetBucketLogging',
    absent: /^$/,
    inverse: (snapshot, input) => ({
      operation: 'PutBucketLogging',
      input: {
        ...bucketOf(input),
        BucketLoggingStatus: snapshot?.LoggingEnabled
          ? { LoggingEnabled: snapshot.LoggingEnabled }
          : {},
      },
    }),
  },
  's3:PutBucketTagging': {
    read: 'GetBucketTagging',
    absent: /NoSuchTagSet/,
    inverse: putOrDelete('PutBucketTagging', 'DeleteBucketTagging', 'Tagging', (s) => ({
      TagSet: s.TagSet,
    })),
  },
  's3:PutBucketAcl': {
    read: 'GetBucketAcl',
    absent: /^$/,
    inverse: (snapshot, input) => ({
      operation: 'PutBucketAcl',
      input: {
        ...bucketOf(input),
        AccessControlPolicy: { Owner: snapshot?.Owner, Grants: snapshot?.Grants },
      },
    }),
  },
  's3control:PutPublicAccessBlock': {
    read: 'GetPublicAccessBlock',
    absent: /NoSuchPublicAccessBlockConfiguration/,
    inverse: (snapshot) =>
      snapshot
        ? {
            operation: 'PutPublicAccessBlock',
            input: { PublicAccessBlockConfiguration: snapshot.PublicAccessBlockConfiguration },
          }
        : { operation: 'DeletePublicAccessBlock', input: {} },
  },
}

/** Inverses may use deletes that are not proposals of their own. */
const INVERSE_ONLY = new Set([
  's3:DeleteBucketOwnershipControls',
  's3:DeleteBucketEncryption',
  's3:DeleteBucketTagging',
  's3control:DeletePublicAccessBlock',
])

export const CHANGE_OPERATIONS = Object.keys(WRITABLE)

export interface ChangeCall {
  service: string
  operation: string
  input: Record<string, unknown>
}

/**
 * Check a proposed write before anything is read or sent: on the allowlist,
 * every input member modelled, and inside the account's scope. An account-wide
 * write is refused on a scoped account.
 */
export function checkChange(config: ProviderConfig, call: ChangeCall, inverse = false): void {
  const service = call.service.toLowerCase()
  const key = `${service}:${call.operation}`
  if (!WRITABLE[key] && !(inverse && INVERSE_ONLY.has(key)))
    throw new ScopeError(
      `${key} is not a change this app makes. It changes reversible bucket configuration only: ${CHANGE_OPERATIONS.join(', ')}.`,
    )
  if (typeof MODULES[service]?.[`${call.operation}Command`] !== 'function')
    throw new Error(`${service} has no operation ${call.operation}.`)
  checkInput(service, call.operation, call.input)
  const scope = config.scope.buckets
  if (!scope.length) return
  const bucket = call.input.Bucket
  if (service === 's3control' || typeof bucket !== 'string' || !scope.includes(bucket))
    throw new ScopeError(
      `This account is scoped to ${scope.join(', ')}; ${key}${typeof bucket === 'string' ? ` on "${bucket}"` : ''} reaches beyond it.`,
    )
}

/** A policy document may be given as an object; the API takes it as JSON text. */
export function normaliseInput(input: Record<string, unknown>): Record<string, unknown> {
  return typeof input.Policy === 'object' && input.Policy !== null
    ? { ...input, Policy: JSON.stringify(input.Policy) }
    : input
}

async function send(
  providers: Providers,
  config: ProviderConfig,
  service: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const Command = MODULES[service]![`${operation}Command`] as new (input: unknown) => unknown
  const client = providers.clientFor(config, service, config.region || 'us-east-1')
  let sent = input
  // S3 Control names the account on every call.
  if (service === 's3control' && sent.AccountId === undefined) {
    const { GetCallerIdentityCommand } = await import('@aws-sdk/client-sts')
    const identity = await providers.sts(config).send(new GetCallerIdentityCommand({}))
    sent = { ...sent, AccountId: identity.Account }
  }
  return (await client.send(new Command(sent) as never)) as Record<string, unknown>
}

/** What the change will replace: the current state, or null when nothing is set. */
export async function snapshotOf(
  providers: Providers,
  config: ProviderConfig,
  call: ChangeCall,
): Promise<Record<string, unknown> | null> {
  const service = call.service.toLowerCase()
  const writable = WRITABLE[`${service}:${call.operation}`]!
  const readInput = service === 's3control' ? {} : bucketOf(call.input)
  try {
    const response = await send(providers, config, service, writable.read, readInput)
    return shape(response) as Record<string, unknown>
  } catch (error) {
    const named = error as { name?: string; Code?: string; message?: string }
    const code = `${named.name ?? ''} ${named.Code ?? ''} ${named.message ?? ''}`
    if (writable.absent.source !== '^$' && writable.absent.test(code)) return null
    throw new Error(
      `The current state could not be read (${named.name ?? 'error'}: ${named.message ?? ''}), so the change could not be rolled back; it is not proposed.`,
    )
  }
}

/** The call that undoes an applied change, from what it replaced. */
export function inverseOf(call: ChangeCall, snapshot: Record<string, unknown> | null): ChangeCall {
  const service = call.service.toLowerCase()
  const writable = WRITABLE[`${service}:${call.operation}`]
  if (!writable) throw new Error(`${service}:${call.operation} cannot be rolled back.`)
  const inverse = writable.inverse(snapshot, call.input)
  return { service, operation: inverse.operation, input: inverse.input }
}

/** Run one approved write with the account's write configuration. */
export async function applyChange(
  providers: Providers,
  config: ProviderConfig,
  call: ChangeCall,
): Promise<unknown> {
  const write = providers.writeConfig(config)
  const response = await send(
    providers,
    write,
    call.service.toLowerCase(),
    call.operation,
    normaliseInput(call.input),
  )
  return shape(response)
}

export function newChangeId(): string {
  return randomUUID()
}
