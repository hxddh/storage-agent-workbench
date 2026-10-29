const PATTERNS: [RegExp, string][] = [
  [/\b(AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g, '$1[redacted]'],
  [/(X-Amz-(?:Credential|Signature|Security-Token|SignedHeaders))=[^&\s"']+/gi, '$1=[redacted]'],
  [/((?:Authorization|X-Api-Key|x-api-key)\s*[:=]\s*)[^\s"',]+/gi, '$1[redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]'],
  [
    /("(?:SecretAccessKey|SessionToken|AccessKeyId|secretAccessKey|sessionToken|accessKeyId|api_key|apiKey|password|token)"\s*:\s*)"[^"]*"/g,
    '$1"[redacted]"',
  ],
  [/arn:(aws|aws-cn|aws-us-gov):([^:\s]+):[^:\s]*:(\d{12}):/g, 'arn:$1:$2:[account]:'],
  [/\b(sig|signature)=[A-Za-z0-9%+/=]{16,}/gi, '$1=[redacted]'],
  [/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{16,}/g, '$1[redacted]'],
  [/((?:aws_secret_access_key|aws_session_token)\s*=\s*)\S+/gi, '$1[redacted]'],
]

/** Remove credential-shaped text before it reaches a model, a log or the UI. */
export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

const SECRET_KEYS = /^(secret|token|password|authorization|credential|signature|api[_-]?key)/i

/** Deep-redact a JSON value; also caps strings so a hostile object cannot bloat a view. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return null
  if (typeof value === 'string') return redact(value.slice(0, 4000))
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactDeep(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(key)) continue
      out[key] = redactDeep(v, depth + 1)
    }
    return out
  }
  return null
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
 * Make stored data safe inside an XML-like envelope. The tags around tool output
 * are the model's only structural boundary; a bucket tag or object metadata
 * value containing `</untrusted-data>` must not be able to close it.
 */
export function escapeTags(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
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
