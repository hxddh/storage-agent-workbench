import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { lit, map, obj, opt, str, union } from '@earendil-works/pi-schema'
import { shape } from '../s3/api'
import { agentTool, providerParam, type ToolDeps } from './policy'

interface Answer {
  url: string
  addresses: string[]
  status: number
  headers: Record<string, string | string[] | undefined>
  tls: Record<string, unknown> | null
  /** The first bytes of a GET's body, as text. */
  body?: string
  ms: { dns: number; total: number }
}

/** How much of a GET's body comes back: enough to see a listing or an error document. */
const BODY_BYTES = 4096

/** Addresses that are not the public internet: this machine, private networks, link-local, CGNAT. */
const PRIVATE = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (!family) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped) return !PRIVATE.check(mapped, 'ipv4')
  return !PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

/** One unsigned request, as the endpoint answers it: status, headers, certificate, timing. */
type Method = 'HEAD' | 'GET' | 'OPTIONS'

/** Headers that would carry a credential; the probe never sends one. */
const CREDENTIAL =
  /^(authorization|cookie|proxy-authorization|x-amz-security-token|x-amz-credential|x-amz-signature|x-amz-date|x-amz-content-sha256)$/i

async function probe(
  url: URL,
  method: Method,
  headers: Record<string, string>,
  signal: AbortSignal,
  privateAllowed: boolean,
): Promise<Answer> {
  const started = Date.now()
  const resolved = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  const addresses = resolved.map((item) => item.address)
  const dns = Date.now() - started
  if (!privateAllowed && !resolved.every((item) => isPublicAddress(item.address)))
    throw new Error(
      `${url.hostname} resolves to an address that is not on the public internet (${addresses.join(', ')}); the probe reaches public hosts and the account's own endpoint only.`,
    )
  // Connect to the address that was checked, not to a second lookup's answer.
  const pinned = resolved[0]!
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const options = {
      method,
      signal,
      headers,
      lookup: (_host: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) =>
        opts?.all
          ? callback(null, [{ address: pinned.address, family: pinned.family }])
          : callback(null, pinned.address, pinned.family),
    }
    const req = send(url, options as never, (res) => {
      const socket = res.socket as TLSSocket
      const cert =
        typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        if (method !== 'GET' || size >= BODY_BYTES) return
        chunks.push(chunk.subarray(0, BODY_BYTES - size))
        size += Math.min(chunk.length, BODY_BYTES - size)
      })
      res.on('end', () =>
        resolve({
          url: url.toString(),
          addresses,
          status: res.statusCode ?? 0,
          headers: res.headers,
          tls:
            cert && Object.keys(cert).length
              ? {
                  protocol: socket.getProtocol?.() ?? null,
                  subject: cert.subject,
                  issuer: cert.issuer,
                  subjectAltName: cert.subjectaltname,
                  validFrom: cert.valid_from,
                  validTo: cert.valid_to,
                  authorized: socket.authorized,
                  authorizationError: socket.authorizationError ?? null,
                }
              : null,
          ...(method === 'GET' ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
          ms: { dns, total: Date.now() - started },
        }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

export function probeTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'probe',
    description:
      "Send one unsigned HEAD, GET or OPTIONS — what an anonymous user on the internet gets — to the account's endpoint, a bucket's virtual host or website endpoint, a CloudFront domain or any other public host, with any request headers you choose (an Origin and Access-Control-Request-Method for a CORS preflight, a Range, a Host). You get the resolved addresses, HTTP status, headers, the TLS certificate, timing and, for a GET, the first 4 KB of the body. It carries no credentials (Authorization, Cookie, X-Amz-Security-Token and the like are refused), follows no redirect, and reaches a private network address only when it is the account's own endpoint.",
    parameters: obj({
      provider_id: providerParam,
      url: opt(
        str({
          description:
            "Full http(s) URL of a public host or the account's endpoint; default the endpoint itself.",
        }),
      ),
      method: opt(union([lit('HEAD'), lit('GET'), lit('OPTIONS')])),
      headers: opt(
        map(str(), {
          description: 'Request headers to send, e.g. {"Origin": "https://example.com"}.',
        }),
      ),
    }),
    target: (args) => args.url ?? 'endpoint',
    run: async (args, run) => {
      const { config } = await run.provider(args.provider_id)
      const endpoint = new URL(
        config.endpoint || `https://s3.${config.region || 'us-east-1'}.amazonaws.com`,
      )
      const url = new URL(args.url ?? endpoint.toString())
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('The probe reaches http or https only.')
      // Node turns `user:pass@host` into a Basic Authorization header. The
      // probe promises to carry no credential, so refuse it before sending.
      if (url.username || url.password)
        throw new Error('The probe URL carries no credentials; remove the user:pass part.')
      // Any public host; a private address only when it is the account's own endpoint (a local MinIO).
      const host = endpoint.hostname
      const own = url.hostname === host || url.hostname.endsWith(`.${host}`)
      const headers = (args.headers ?? {}) as Record<string, string>
      const refused = Object.keys(headers).filter((name) => CREDENTIAL.test(name))
      if (refused.length)
        throw new Error(`The probe carries no credentials; not sent: ${refused.join(', ')}.`)
      const answer = shape(
        await probe(
          url,
          args.method ?? 'HEAD',
          headers,
          run.signal,
          own && Boolean(config.endpoint),
        ),
      ) as Answer
      return {
        model: JSON.stringify(answer, null, 1),
        note: `HTTP ${answer.status} · ${answer.ms.total} ms`,
        view: {
          kind: 'raw' as const,
          title: `${args.method ?? 'HEAD'} ${answer.url}`,
          value: answer,
        },
      }
    },
  })
}
