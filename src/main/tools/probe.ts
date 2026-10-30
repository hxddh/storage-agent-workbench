import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { scrub } from '../s3/api'
import { agentTool, providerParam, type ToolDeps, Type } from './policy'

interface Answer {
  url: string
  addresses: string[]
  status: number
  headers: Record<string, string | string[] | undefined>
  tls: Record<string, unknown> | null
  ms: { dns: number; total: number }
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
): Promise<Answer> {
  const started = Date.now()
  const addresses = (await lookup(url.hostname, { all: true })).map((item) => item.address)
  const dns = Date.now() - started
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(url, { method, signal, headers }, (res) => {
      const socket = res.socket as TLSSocket
      const cert =
        typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null
      res.resume()
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
      "Send one unsigned HEAD, GET or OPTIONS to the account's endpoint, or to a host under it (a virtual-hosted bucket), with any request headers you choose (an Origin and Access-Control-Request-Method for a CORS preflight, a Range, a Host), and get what came back: resolved addresses, HTTP status, headers, the TLS certificate and timing. It carries no credentials: headers that would (Authorization, Cookie, X-Amz-Security-Token and the like) are refused.",
    parameters: Type.Object({
      provider_id: providerParam,
      url: Type.Optional(
        Type.String({
          description:
            "Full URL on the account's endpoint host or a subdomain of it; default the endpoint itself.",
        }),
      ),
      method: Type.Optional(
        Type.Union([Type.Literal('HEAD'), Type.Literal('GET'), Type.Literal('OPTIONS')]),
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
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
      // The probe reaches the account's own endpoint, never another host.
      const host = endpoint.hostname
      const awsS3 =
        !config.endpoint && /(^|\.)s3([.-][\w-]+)*\.amazonaws\.com(\.cn)?$/.test(url.hostname)
      if (url.hostname !== host && !url.hostname.endsWith(`.${host}`) && !awsS3)
        throw new Error(`The probe reaches only ${host} and hosts under it.`)
      const headers = (args.headers ?? {}) as Record<string, string>
      const refused = Object.keys(headers).filter((name) => CREDENTIAL.test(name))
      if (refused.length)
        throw new Error(`The probe carries no credentials; not sent: ${refused.join(', ')}.`)
      // Headers and certificates can name the account; the agent never sees its id.
      const answer = scrub(await probe(url, args.method ?? 'HEAD', headers, run.signal)) as Answer
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
