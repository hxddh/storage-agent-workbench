export type ReadStatus =
  | 'available'
  | 'not_configured'
  | 'provider_unsupported'
  | 'access_denied'
  | 'error'
  | 'region_mismatch'
  | 'skipped_acls_disabled'

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
  if (UNSUPPORTED.has(code) || http === 501 || http === 405) return 'provider_unsupported'
  if (DENIED.has(code) || http === 403) return 'access_denied'
  return 'error'
}

/** Run one read-only S3 call, mapping failure to a status instead of throwing. */
export async function read<T>(call: () => Promise<T>): Promise<Read<T>> {
  try {
    return { status: 'available', data: await call() }
  } catch (error) {
    return { status: classify(error), data: null }
  }
}

export function dimensionStatus(result: Read<unknown>, configured: boolean): ReadStatus {
  return result.status === 'available'
    ? configured
      ? 'available'
      : 'not_configured'
    : result.status
}
