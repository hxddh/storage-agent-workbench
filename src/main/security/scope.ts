import type { ProviderConfig } from '../providers'

/** A call the app refuses before anything is sent: out of scope, or not a read. */
export class ScopeError extends Error {}

export function assertInScope(provider: ProviderConfig, bucket: string): void {
  if (provider.scope.buckets.length === 0) return
  if (!provider.scope.buckets.includes(bucket)) {
    throw new ScopeError(
      `Bucket '${bucket}' is outside this account's scope (${provider.scope.buckets.join(', ')}).`,
    )
  }
}
