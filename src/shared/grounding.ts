/**
 * Verdict grounding.
 *
 * The verdict is the one thing on the page the model writes. It names buckets,
 * objects and accounts in backticks; every such name must appear in a tool
 * result of the same task. The main process asks the model to correct an
 * ungrounded verdict once, and the window marks whatever still is not grounded.
 */
import type { ToolView, UiEntry } from './contract'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,254}$/

function addTable(names: Set<string>, rows: (string | number | null)[][] | undefined): void {
  for (const row of rows ?? []) {
    const first = row[0]
    if (typeof first === 'string' && first) names.add(first)
  }
}

/** Names a tool result shows: targets, bucket and key columns, Issue buckets, accounts. */
export function namesInView(
  view: ToolView | null,
  target: string,
  names: Set<string>,
  tool?: string,
): void {
  // A query's `target` is the model's own title, not a storage name; grounding
  // it would let the model certify a name it invented.
  if (target && tool !== 'query') names.add(target)
  if (!view) return
  switch (view.kind) {
    case 'survey':
      names.add(view.provider)
      addTable(names, view.buckets.rows)
      for (const issue of view.issues) names.add(issue.bucket)
      for (const bucket of view.coverage.gone ?? []) names.add(bucket)
      for (const bucket of view.coverage.denied) names.add(bucket)
      break
    case 'estate':
      addTable(names, view.buckets?.rows)
      for (const issue of view.issues) names.add(issue.bucket)
      break
    case 'buckets':
    case 'objects':
      addTable(names, view.rows.rows)
      break
    case 'config':
    case 'fix':
      names.add(view.bucket)
      break
    case 'object':
      for (const [, value] of view.facts) if (NAME.test(value)) names.add(value)
      break
    case 'probe':
      names.add(view.endpoint)
      break
    case 'query': {
      for (const bucket of view.buckets ?? []) names.add(bucket)
      // The first column, and any column that holds names, grounds what the verdict says.
      const named = view.rows.columns
        .map((column, index) =>
          index === 0 || /bucket|key|prefix|name/i.test(column) ? index : -1,
        )
        .filter((index) => index >= 0)
      for (const row of view.rows.rows)
        for (const index of named) {
          const value = row[index]
          if (typeof value === 'string' && value) names.add(value)
        }
      break
    }
    default:
      break
  }
}

export function knownNames(entries: readonly UiEntry[]): Set<string> {
  const names = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'tool' && entry.status === 'done')
      namesInView(entry.view, entry.target, names, entry.name)
    if (entry.kind === 'user') {
      for (const file of entry.attachments) names.add(file.name)
    }
  }
  return names
}

/** Backticked names in the verdict that no tool result in the task shows. */
export function ungrounded(verdict: string, known: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const match of verdict.matchAll(/`([^`\n]{1,256})`/g)) {
    const name = match[1]!.trim()
    if (!NAME.test(name)) continue
    if (known.has(name)) continue
    // A key under a known bucket ("bucket/key") or a known prefix is grounded by its bucket.
    const head = name.split('/')[0]!
    if (name.includes('/') && known.has(head)) continue
    out.add(name)
  }
  return [...out]
}

/**
 * What the task's readings say about each bucket's public exposure: true when
 * proved public, false when proved not. Later readings replace earlier ones.
 */
export function exposureInView(view: ToolView | null, exposure: Map<string, boolean>): void {
  if (!view) return
  const fromTable = (table: { columns: string[]; rows: (string | number | null)[][] } | null) => {
    if (!table) return
    const column = table.columns.indexOf('Public')
    if (column < 0) return
    for (const row of table.rows) {
      const bucket = row[0]
      if (typeof bucket !== 'string') continue
      if (row[column] === 'public') exposure.set(bucket, true)
      else if (row[column] === 'no') exposure.set(bucket, false)
    }
  }
  if (view.kind === 'survey') fromTable(view.buckets)
  else if (view.kind === 'estate') fromTable(view.buckets)
  else if (view.kind === 'config' && (view.aspect ?? 'security') === 'security') {
    if (view.exposure === 'public') exposure.set(view.bucket, true)
    else if (view.exposure === 'not public') exposure.set(view.bucket, false)
    else if (view.findings.some((finding) => finding.code === 'public_exposure'))
      exposure.set(view.bucket, true)
  }
}

export function knownExposure(entries: readonly UiEntry[]): Map<string, boolean> {
  const exposure = new Map<string, boolean>()
  for (const entry of entries)
    if (entry.kind === 'tool' && entry.status === 'done') exposureInView(entry.view, exposure)
  return exposure
}

const PUBLIC =
  /\bpublic(ly)?\b|\banonymous(ly)?\b|\bopen to (anyone|everyone|the internet)\b|公开|匿名/i
const NEGATION =
  /\bnot\b|n['’]t\b|\bno longer\b|\bnever\b|\bneither\b|\bnor\b|\bnone\b|\bprivate\b|不|没有|未|非|无/i

/**
 * Sentences that name exactly one bucket and say it is, or is not, public
 * against what the readings proved. Only exposure is checked: it is the claim
 * that matters most and the one a sentence states plainly.
 */
export function contradicted(verdict: string, exposure: ReadonlyMap<string, boolean>): string[] {
  const out = new Set<string>()
  for (const sentence of verdict.split(/(?<=[.!?。！？；;])\s*/)) {
    const names = [...sentence.matchAll(/`([^`\n]{1,256})`/g)].map((m) => m[1]!.trim())
    const known = names.filter((name) => exposure.has(name))
    if (names.length !== 1 || known.length !== 1) continue
    // Look for the claim in the prose, not inside the backticked name: a bucket
    // called `demo-public` must not make "is no longer public" a public claim.
    const prose = sentence.replace(/`[^`\n]*`/g, 'name')
    const match = PUBLIC.exec(prose)
    if (!match) continue
    // Negation counts only just before the claim: "has no encryption but is public" is a public claim.
    const claimsPublic = !NEGATION.test(prose.slice(Math.max(0, match.index - 32), match.index))
    const name = known[0]!
    if (claimsPublic !== exposure.get(name)) out.add(name)
  }
  return [...out]
}
