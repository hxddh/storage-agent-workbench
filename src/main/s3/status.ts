export type ReadStatus =
  | 'available'
  | 'not_configured'
  | 'provider_unsupported'
  | 'access_denied'
  | 'error'
  | 'region_mismatch'
  | 'skipped_acls_disabled'
  | 'missing'
  | 'unread'
  | 'truncated'

const NOT_CONFIGURED = new Set([
  'NoSuchLifecycleConfiguration',
  'NoSuchBucketPolicy',
  'NoSuchCORSConfiguration',
  'ServerSideEncryptionConfigurationNotFoundError',
  'ReplicationConfigurationNotFoundError',
  'NoSuchPublicAccessBlockConfiguration',
  'NoSuchTagSet',
  'NoSuchTagSetError',
  'NoSuchConfiguration',
  'NoSuchWebsiteConfiguration',
  'ObjectLockConfigurationNotFoundError',
  'OwnershipControlsNotFoundError',
])

const UNSUPPORTED = new Set(['NotImplemented', 'MethodNotAllowed', 'NotSupported', 'Unsupported'])
const DENIED = new Set(['AccessDenied', 'Forbidden', 'AllAccessDisabled', 'UnauthorizedAccess'])

export interface Read<T> {
  status: ReadStatus
  data: T | null
}

export function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
}

export function errorCode(error: unknown): string {
  return String((error as { name?: string })?.name ?? '')
}

export function classify(error: unknown): ReadStatus {
  const code = errorCode(error)
  const http = httpStatus(error)
  if (NOT_CONFIGURED.has(code)) return 'not_configured'
  if (code === 'NoSuchBucket') return 'missing'
  if (code === 'PermanentRedirect' || code === 'AuthorizationHeaderMalformed' || http === 301)
    return 'region_mismatch'
  if (UNSUPPORTED.has(code) || http === 501 || http === 405) return 'provider_unsupported'
  if (DENIED.has(code) || http === 403) return 'access_denied'
  return 'error'
}

export function isAbort(error: unknown): boolean {
  const name = errorCode(error)
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Run one read-only S3 call, mapping failure to a status instead of throwing.
 * An abort is not a status: it propagates so the caller stops.
 */
export async function read<T>(call: () => Promise<T>): Promise<Read<T>> {
  try {
    return { status: 'available', data: await call() }
  } catch (error) {
    if (isAbort(error)) throw error
    return { status: classify(error), data: null }
  }
}

/** A status that leaves the question open: the read could not see. */
export function blind(status: ReadStatus): boolean {
  return (
    status === 'access_denied' ||
    status === 'error' ||
    status === 'provider_unsupported' ||
    status === 'region_mismatch' ||
    status === 'missing' ||
    status === 'truncated'
  )
}

export function dimensionStatus(result: Read<unknown>, configured: boolean): ReadStatus {
  return result.status === 'available'
    ? configured
      ? 'available'
      : 'not_configured'
    : result.status
}
