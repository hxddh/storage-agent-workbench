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
  /** Deterministic objects spread over these prefixes and three years. */
  objects?: { count: number; prefixes: string[] }
}

export interface FakeReply {
  status: number
  headers: Record<string, string>
  body: string
}

export const DEFAULT_BUCKETS: Record<string, FakeBucket>
export function objectsOf(
  config: FakeBucket,
): { key: string; size: number; modified?: string; storageClass?: string }[]
export function respond(
  buckets: Record<string, FakeBucket>,
  request: { method?: string; path?: string },
): FakeReply
