/**
 * Capacity from CloudWatch's daily S3 storage metrics: bytes per storage class,
 * object count, growth over two weeks, and a monthly storage estimate at list
 * price. One GetMetricData call answers dozens of buckets of one region.
 *
 * The estimate is storage only, at us-east-1 list prices; requests, transfer,
 * retrieval and discounts are not in it, and the view says so.
 */
import { type CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { isAbort } from './status'

export interface Capacity {
  bytes: number
  objects: number | null
  byClass: Record<string, number>
  /** Bytes added over the window; null with fewer than two daily points. */
  growthBytes: number | null
  monthlyUsd: number
  at: string
}

/** us-east-1 list price per GiB-month by CloudWatch StorageType. */
export const PRICE_PER_GIB: Record<string, number> = {
  StandardStorage: 0.023,
  IntelligentTieringFAStorage: 0.023,
  IntelligentTieringIAStorage: 0.0125,
  IntelligentTieringAIAStorage: 0.004,
  IntelligentTieringAAStorage: 0.0036,
  IntelligentTieringDAAStorage: 0.00099,
  StandardIAStorage: 0.0125,
  OneZoneIAStorage: 0.01,
  ReducedRedundancyStorage: 0.024,
  GlacierInstantRetrievalStorage: 0.004,
  GlacierStorage: 0.0036,
  GlacierStagingStorage: 0.0036,
  DeepArchiveStorage: 0.00099,
  DeepArchiveStagingStorage: 0.00099,
}

const STORAGE_TYPES = Object.keys(PRICE_PER_GIB)
const GIB = 1024 ** 3
const WINDOW_DAYS = 15
/** GetMetricData accepts 500 queries per call. */
const QUERIES_PER_CALL = 500

export function monthlyUsd(byClass: Record<string, number>): number {
  let total = 0
  for (const [type, bytes] of Object.entries(byClass))
    total += (bytes / GIB) * (PRICE_PER_GIB[type] ?? 0.023)
  return Math.round(total * 100) / 100
}

export async function readCapacity(
  client: CloudWatchClient,
  buckets: string[],
  signal?: AbortSignal,
  now = new Date(),
): Promise<{ capacity: Map<string, Capacity>; status: 'available' | 'access_denied' | 'error' }> {
  const capacity = new Map<string, Capacity>()
  type Query = { id: string; bucket: string; metric: 'size' | 'objects'; type: string }
  const queries: Query[] = []
  for (const [b, bucket] of buckets.entries()) {
    for (const [t, type] of STORAGE_TYPES.entries())
      queries.push({ id: `s${b}_${t}`, bucket, metric: 'size', type })
    queries.push({ id: `o${b}`, bucket, metric: 'objects', type: 'AllStorageTypes' })
  }
  const series = new Map<string, { at: number; value: number }[]>()
  try {
    for (let start = 0; start < queries.length; start += QUERIES_PER_CALL) {
      const chunk = queries.slice(start, start + QUERIES_PER_CALL)
      let token: string | undefined
      do {
        const response = await client.send(
          new GetMetricDataCommand({
            StartTime: new Date(now.getTime() - WINDOW_DAYS * 86_400_000),
            EndTime: now,
            NextToken: token,
            MetricDataQueries: chunk.map((q) => ({
              Id: q.id,
              ReturnData: true,
              MetricStat: {
                Period: 86_400,
                Stat: 'Average',
                Metric: {
                  Namespace: 'AWS/S3',
                  MetricName: q.metric === 'size' ? 'BucketSizeBytes' : 'NumberOfObjects',
                  Dimensions: [
                    { Name: 'BucketName', Value: q.bucket },
                    { Name: 'StorageType', Value: q.type },
                  ],
                },
              },
            })),
          }),
          { abortSignal: signal },
        )
        for (const result of response.MetricDataResults ?? []) {
          if (!result.Id) continue
          const points = (result.Timestamps ?? []).map((ts, i) => ({
            at: new Date(ts).getTime(),
            value: result.Values?.[i] ?? 0,
          }))
          series.set(result.Id, [...(series.get(result.Id) ?? []), ...points])
        }
        token = response.NextToken
      } while (token)
    }
  } catch (error) {
    if (isAbort(error)) throw error
    const name = (error as { name?: string })?.name ?? ''
    const http = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
    return {
      capacity,
      status: name.includes('AccessDenied') || http === 403 ? 'access_denied' : 'error',
    }
  }

  const at = now.toISOString()
  buckets.forEach((bucket, b) => {
    const byClass: Record<string, number> = {}
    let latest = 0
    let earliest = 0
    let points = 0
    STORAGE_TYPES.forEach((type, t) => {
      const values = (series.get(`s${b}_${t}`) ?? []).sort((x, y) => x.at - y.at)
      if (!values.length) return
      byClass[type] = values.at(-1)!.value
      latest += values.at(-1)!.value
      earliest += values[0]!.value
      points = Math.max(points, values.length)
    })
    const objects = (series.get(`o${b}`) ?? []).sort((x, y) => x.at - y.at).at(-1)?.value ?? null
    if (!points && objects === null) return
    capacity.set(bucket, {
      bytes: latest,
      objects,
      byClass,
      growthBytes: points >= 2 ? latest - earliest : null,
      monthlyUsd: monthlyUsd(byClass),
      at,
    })
  })
  return { capacity, status: 'available' }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
