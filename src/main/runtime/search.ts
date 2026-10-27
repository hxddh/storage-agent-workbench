import type { SearchHit, UiEntry } from '@shared/contract'
import { deriveFacts, factsSearchText } from '@shared/facts'
import { buildRun } from '@shared/run'
import type { AppDb } from '../db'

/**
 * Sidebar search over titles (read from `task_meta`) and the derived
 * `search_docs` index: requests, findings and the current answer. `LIKE`
 * handles Chinese substrings that a trigram index cannot.
 */
export async function searchTasks(db: AppDb, query: string): Promise<SearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const needle = q.toLowerCase()
  const tasks = await db.listTaskMeta()
  const byId = new Map(tasks.map((task) => [task.conversation_id, task]))
  const hits = new Map<string, SearchHit>()
  for (const task of tasks) {
    const at = task.title.toLowerCase().indexOf(needle)
    if (at < 0) continue
    hits.set(task.conversation_id, {
      taskId: task.conversation_id,
      title: task.title,
      kind: 'title',
      snippet: task.title,
      matchStart: at,
      matchLength: q.length,
      entryId: null,
    })
  }
  for (const doc of await db.searchDocs(q, 300)) {
    if (hits.has(doc.conversation_id)) continue
    const task = byId.get(doc.conversation_id)
    if (!task) continue
    const index = doc.text.toLowerCase().indexOf(needle)
    if (index < 0) continue
    const start = Math.max(0, index - 60)
    const end = Math.min(doc.text.length, index + q.length + 90)
    const lead = start > 0 ? 1 : 0
    hits.set(doc.conversation_id, {
      taskId: doc.conversation_id,
      title: task.title,
      kind: doc.kind === 'user' ? 'user' : doc.kind === 'finding' ? 'finding' : 'answer',
      snippet: `${start > 0 ? '…' : ''}${doc.text
        .slice(start, end)
        .replace(/\s+/g, ' ')
        .trim()}${end < doc.text.length ? '…' : ''}`,
      matchStart: index - start + lead,
      matchLength: q.length,
      entryId: doc.entry_id,
    })
  }
  return [...hits.values()].slice(0, 20)
}

/** The rows a settled task contributes to the index, from the same projection the window renders. */
export function searchDocsFor(
  entries: readonly UiEntry[],
): { entryId: string; kind: string; text: string; at: string }[] {
  const docs: { entryId: string; kind: string; text: string; at: string }[] = []
  for (const entry of entries) {
    if (entry.kind === 'user')
      docs.push({ entryId: entry.id, kind: 'user', text: entry.text, at: entry.at })
  }
  // The projection may be partial while a task is still working; the
  // deterministic evidence must still be searchable even then.
  let run: ReturnType<typeof buildRun> | null = null
  try {
    run = buildRun(entries)
  } catch {
    run = null
  }
  docs.push(...factsSearchText(run?.facts ?? deriveFacts(entries)))
  return docs
}
