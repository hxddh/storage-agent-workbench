/** Which S3-compatible provider an account is, from its endpoint. */
export type ProviderKind = 'aws' | 'r2' | 'minio' | 'aliyun' | 'gcs' | 'other'

export function detectProviderKind(endpoint: string): ProviderKind {
  const url = endpoint.toLowerCase()
  if (!url) return 'aws'
  if (url.includes('r2.cloudflarestorage.com')) return 'r2'
  if (url.includes('aliyuncs.com')) return 'aliyun'
  if (url.includes('storage.googleapis.com')) return 'gcs'
  if (url.includes('minio') || url.includes('localhost') || url.includes('127.0.0.1'))
    return 'minio'
  return 'other'
}
