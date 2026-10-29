import type { Server } from 'node:http'
import type { FakeBucket } from './fake-s3-core.mjs'

export type { FakeBucket }

export const DEFAULT_BUCKETS: Record<string, FakeBucket>

export function startFakeS3(options?: {
  port?: number
  buckets?: Record<string, FakeBucket>
  slowMs?: number
}): Promise<{ server: Server; buckets: Record<string, FakeBucket>; endpoint: string }>
