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
export function namesInView(view: ToolView | null, target: string, names: Set<string>): void {
  if (target) names.add(target)
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
    case 'analyze':
      names.add(view.dataset)
      addTable(names, view.rows.rows)
      break
    case 'probe':
      names.add(view.endpoint)
      break
    default:
      break
  }
}

export function knownNames(entries: readonly UiEntry[]): Set<string> {
  const names = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'tool' && entry.status === 'done')
      namesInView(entry.view, entry.target, names)
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
