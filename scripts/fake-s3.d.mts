import type { Server } from 'node:http'

export interface FakeBucket {
  public?: boolean
  encryption?: boolean
  blocked?: boolean
  /** No GetBucketPolicyStatus or public access block (501), like most S3-compatible stores. */
  compat?: boolean
  /** GetBucketAcl answers 403. */
  aclDenied?: boolean
  /** An Allow to `*` narrowed by an aws:SourceIp condition. */
  conditional?: boolean
  versioning?: boolean
  lifecycle?: 'abort' | 'expire'
  cors?: string
  region?: string
}

export const DEFAULT_BUCKETS: Record<string, FakeBucket>

export function startFakeS3(options?: {
  port?: number
  buckets?: Record<string, FakeBucket>
  slowMs?: number
}): Promise<{ server: Server; buckets: Record<string, FakeBucket>; endpoint: string }>
