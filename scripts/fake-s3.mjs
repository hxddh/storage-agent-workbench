/**
 * The fake S3 over HTTP, for end-to-end runs and domain tests. The responder
 * itself lives in `src/main/demo/fake-s3-core.mjs`, which the app's demo
 * account also uses in process.
 *
 *   node scripts/fake-s3.mjs 9100
 */
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BUCKETS, respond } from '../src/main/demo/fake-s3-core.mjs'

export { DEFAULT_BUCKETS }

/** Start a fake S3 on `port` (0 picks one). Resolves to the server and its endpoint. */
export function startFakeS3({
  port = 0,
  buckets = structuredClone(DEFAULT_BUCKETS),
  slowMs = 0,
} = {}) {
  const server = createServer((req, res) => {
    const handle = () => {
      const answer = respond(buckets, { method: req.method, path: req.url })
      res.writeHead(answer.status, answer.headers)
      res.end(answer.body)
    }
    // Drain the body (the fix control POSTs none) before answering.
    req.resume()
    req.on('end', () => (slowMs > 0 ? setTimeout(handle, slowMs) : handle()))
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, buckets, endpoint: `http://127.0.0.1:${address.port}` })
    })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 9100)
  await startFakeS3({ port, slowMs: Number(process.env.SLOW_MS ?? 0) })
  console.log(`fake-s3 listening on ${port}`)
}
