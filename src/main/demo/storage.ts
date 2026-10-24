/**
 * Demo storage: a believable estate answered in process. The S3 client's
 * request handler calls the fake responder directly, so there is no port, no
 * server and no network — the demo account behaves like an S3-compatible
 * provider and every tool works against it.
 */
import { Readable } from 'node:stream'
import { DEMO_BUCKETS, type FakeBucket, respond } from './fake-s3-core.mjs'

/** The endpoint a demo account stores; never contacted. */
export const DEMO_ENDPOINT = 'https://demo.storage-agent.invalid'

const estates = new Map<string, Record<string, FakeBucket>>()

interface SdkRequest {
  method: string
  path: string
  query?: Record<string, string | string[] | null>
}

/** An AWS SDK request handler that answers from the demo estate of one account. */
export function demoHandler(accountId: string) {
  if (!estates.has(accountId)) estates.set(accountId, structuredClone(DEMO_BUCKETS))
  const buckets = estates.get(accountId)!
  return {
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(request: SdkRequest) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(request.query ?? {})) {
        if (Array.isArray(value)) for (const v of value) search.append(key, v)
        else search.append(key, value ?? '')
      }
      const query = search.toString()
      const answer = respond(buckets, {
        method: request.method,
        path: `${request.path}${query ? `?${query}` : ''}`,
      })
      return {
        response: {
          statusCode: answer.status,
          reason: '',
          headers: answer.headers,
          body: Readable.from([Buffer.from(answer.body, 'utf8')]),
        },
      }
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {}
    },
    destroy() {},
  }
}
