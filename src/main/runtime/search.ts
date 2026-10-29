import type { SearchHit } from '@shared/contract'
import type { AppDb } from '../db'

/**
 * Sidebar search over titles (read from `task_meta`) and the derived
 * `search_docs` index: the user's messages and the agent's text. `LIKE`
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
    // 35.x indexed its findings; a finding is the agent's data now, not something said.
    if (doc.kind === 'finding') continue
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
      kind: doc.kind === 'user' ? 'user' : 'answer',
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
