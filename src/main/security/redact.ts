import { randomBytes } from 'node:crypto'

/**
 * Secrets only. Identifiers — account ids, access key ids, ARNs, bucket and
 * key names — are what the agent reasons with and reach it as the service
 * returned them.
 */
const PATTERNS: [RegExp, string][] = [
  // A PEM private key, whole.
  [
    /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    '-----BEGIN $1PRIVATE KEY-----[redacted]-----END $1PRIVATE KEY-----',
  ],
  // A secret key next to its access key id: the IAM console's CSV, a pasted pair.
  [
    /\b(A[KS]IA[0-9A-Z]{16})([\s,;:|"']{1,4})([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/g,
    '$1$2[redacted]',
  ],
  [/(X-Amz-(?:Credential|Signature|Security-Token|SignedHeaders))=[^&\s"']+/gi, '$1=[redacted]'],
  [/((?:Authorization|X-Api-Key|x-api-key)\s*[:=]\s*)[^\s"',]+/gi, '$1[redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]'],
  [
    /("(?:SecretAccessKey|SessionToken|secretAccessKey|sessionToken|aws_secret_access_key|aws_session_token|secret_access_key|client_secret|private_key|api_key|apiKey|password|token)"\s*:\s*)"[^"]*"/g,
    '$1"[redacted]"',
  ],
  [/\b(sig|signature)=[A-Za-z0-9%+/=]{16,}/gi, '$1=[redacted]'],
  [/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{16,}/g, '$1[redacted]'],
  // ini, YAML and env lines.
  [
    /\b((?:aws_secret_access_key|aws_session_token|secret_access_key|client_secret|password|passwd)\s*[:=]\s*)(?!\[redacted\])[^\s"',]+/gi,
    '$1[redacted]',
  ],
]

/** Remove credential-shaped text before it reaches a model, a log or the UI. */
export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Walk a tool view and redact every string without dropping rows or columns. */
export function redactView(value: unknown, depth = 0): unknown {
  if (depth > 64) return null
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.map((item) => redactView(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[key] = redactView(item, depth + 1)
    return out
  }
  return null
}

/**
 * Data from outside — a service's response, an object body, a file, a child
 * agent's text — inside a block whose closing tag carries a random boundary.
 * Nothing inside is rewritten: a key spelled `a&b <1>.csv` reaches the agent
 * so, and calling with it works. Text inside cannot close the block, because
 * it cannot know the boundary.
 */
export function wrapUntrusted(source: string, text: string, evidenceId?: string): string {
  const tag = `untrusted-data-${randomBytes(6).toString('hex')}`
  const attrs = [`source="${attribute(source)}"`]
  if (evidenceId) attrs.push(`evidence="${attribute(evidenceId)}"`)
  return `<${tag} ${attrs.join(' ')}>\n${redact(text)}\n</${tag}>`
}

function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Keep a tool result bounded for the model. */
export function bound(text: string, max = 24_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… truncated (${text.length - max} chars)`
}

export function maskKey(value: string | null): string {
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}
