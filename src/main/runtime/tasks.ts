/**
 * The task list and the open task.
 *
 * A task is a pi conversation plus a title row. This keeps the sidebar, the one
 * watched task, the search index and the user's own acts on memory (deleting a
 * note). Runs belong to the engine.
 */
import { rm } from 'node:fs/promises'
import type { ConversationView, TaskGraph, WatchHandle } from '@earendil-works/pi-durable'
import type {
  ContextRef,
  Live,
  NoteRow,
  SearchHit,
  StorageRef,
  TaskModel,
  TaskSummary,
  TaskView,
  UiEntry,
} from '@shared/contract'
import { searchRows } from '@shared/conversation'
import { deriveTitle, LiveTracker, mapEntries, usageOf } from './project'
import { searchTasks } from './search'
import { CONTEXT, parseTaskModel, type Runtime } from './session'

const INITIAL_ENTRIES = 200

interface ActiveWatch {
  id: string
  watch: WatchHandle<ConversationView>
  seen: Set<string>
  entries: UiEntry[]
}

export class Tasks {
  private readonly live = new LiveTracker()
  private active: ActiveWatch | null = null
  private graphWatch: WatchHandle<TaskGraph> | null = null
  private graph: Record<string, { conversationId?: string; status?: string }> = {}

  constructor(private readonly runtime: Runtime) {}

  private get deps() {
    return this.runtime.deps
  }

  start(): void {
    this.watchGraph()
    void this.backfillSearch()
  }

  async newTask(text: string): Promise<string> {
    const conversation = await this.runtime.pi.createConversation(
      { ownership: { kind: 'ownerless' } } as never,
      CONTEXT,
    )
    const id = String(conversation.id)
    await this.deps.db.upsertTaskMeta({ conversationId: id, title: deriveTitle(text) })
    await this.refreshList()
    return id
  }

  /** Whether a turn is running in this task. */
  async busy(taskId: string): Promise<boolean> {
    const conversation = await this.runtime.conversation(taskId)
    if (!conversation) return false
    const state = await conversation.viewState(CONTEXT)
    try {
      return Boolean((state.value.docs['pi.live'] as { run?: unknown } | undefined)?.run)
    } finally {
      state.dispose()
    }
  }

  async waitForIdle(taskId: string): Promise<void> {
    const conversation = await this.runtime.conversation(taskId)
    await conversation?.waitForIdle(CONTEXT)
  }

  /** Names the user pointed at, checked against the accounts and their scope. */
  async sanitizeContext(context: ContextRef[]): Promise<ContextRef[]> {
    if (!Array.isArray(context) || context.length === 0) return []
    const accounts = await this.deps.providers.list()
    const out: ContextRef[] = []
    for (const raw of context) {
      if (!raw || typeof raw !== 'object') continue
      const account = accounts.find((item) => item.id === raw.providerId)
      if (!account) continue
      if (raw.kind === 'account') {
        out.push({ kind: 'account', providerId: account.id, label: account.name })
        continue
      }
      const bucket = typeof raw.bucket === 'string' ? raw.bucket : ''
      if (!bucket || (account.scope.buckets.length && !account.scope.buckets.includes(bucket)))
        continue
      out.push({ kind: 'bucket', providerId: account.id, label: bucket, bucket })
    }
    return out
  }

  async storageRefs(query: string): Promise<StorageRef[]> {
    const accounts = await this.deps.providers.list()
    const term = query.trim().toLowerCase()
    const refs: StorageRef[] = []
    for (const account of accounts) {
      if (!term || account.name.toLowerCase().includes(term))
        refs.push({
          id: `a:${account.id}`,
          kind: 'account',
          providerId: account.id,
          label: account.name,
          detail: account.endpoint || 'AWS',
        })
      // The buckets the account lists now; the app keeps no memory of them.
      const buckets = (await this.deps.providers.bucketNames(account.id).catch(() => []))
        .filter((name) => !term || name.toLowerCase().includes(term))
        .slice(0, 12)
      for (const name of buckets)
        refs.push({
          id: `b:${account.id}:${name}`,
          kind: 'bucket',
          providerId: account.id,
          label: name,
          bucket: name,
          detail: account.name,
        })
      if (refs.length >= 24) break
    }
    return refs.slice(0, 24)
  }

  search(query: string): Promise<SearchHit[]> {
    return searchTasks(this.deps.db, query)
  }

  async notes(): Promise<NoteRow[]> {
    const rows = await this.deps.db.listNotes()
    const ttl = this.deps.settings.get().noteTtlDays
    const cutoff = ttl > 0 ? Date.now() - ttl * 86_400_000 : null
    return rows
      .filter((note) => !cutoff || Date.parse(note.created_at) >= cutoff)
      .map((note) => ({
        id: note.id,
        text: note.text,
        author: note.author,
        createdAt: note.created_at,
      }))
  }

  async deleteNote(id: string): Promise<void> {
    await this.deps.db.deleteNote(id)
    await this.runtime.refreshDigest()
  }

  async pin(taskId: string, pinned: boolean): Promise<void> {
    await this.deps.db.setPinned(taskId, Boolean(pinned))
    await this.refreshList()
  }

  async rename(taskId: string, title: string): Promise<void> {
    const clean = title.trim().slice(0, 120)
    const meta = await this.deps.db.getTaskMeta(taskId)
    if (!clean || !meta) return
    await this.deps.db.upsertTaskMeta({
      conversationId: taskId,
      title: clean,
      createdAt: meta.created_at,
    })
    await this.refreshList()
  }

  async setTaskModel(taskId: string, model: TaskModel | null): Promise<void> {
    if (!(await this.deps.db.getTaskMeta(taskId))) throw new Error('Task not found.')
    if (!model) await this.deps.db.setTaskModel(taskId, null)
    else {
      const clean = parseTaskModel(JSON.stringify(model))
      if (!clean) throw new Error('Invalid model choice.')
      await this.deps.db.setTaskModel(taskId, JSON.stringify(clean))
    }
    await this.refreshList()
  }

  async deleteTask(taskId: string): Promise<void> {
    if (this.active?.id === taskId) {
      await this.active.watch.stop()
      this.active = null
    }
    const conversation = await this.runtime.conversation(taskId)
    if (conversation) await conversation.abort(CONTEXT).catch(() => undefined)
    this.runtime.failed.delete(taskId)
    await this.deps.db.deleteTaskMeta(taskId)
    await this.deps.db.deleteSearchDocs(taskId)
    await this.deps.db.purgeTask(taskId)
    await rm(this.deps.dirs.task(taskId), { recursive: true, force: true }).catch(() => undefined)
    if (this.deps.settings.get().lastTaskId === taskId) this.deps.settings.setLastTask(null)
    await this.refreshList()
  }

  async list(): Promise<TaskSummary[]> {
    return (await this.deps.db.listTaskMeta()).map((row) => ({
      id: row.conversation_id,
      title: row.title,
      state: this.stateOf(row.conversation_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pinned: row.pinned === 1,
    }))
  }

  async summary(taskId: string): Promise<TaskSummary | null> {
    const meta = await this.deps.db.getTaskMeta(taskId)
    if (!meta) return null
    return {
      id: taskId,
      title: meta.title,
      state: this.stateOf(taskId),
      createdAt: meta.created_at,
      updatedAt: meta.updated_at,
      pinned: meta.pinned === 1,
    }
  }

  async open(taskId: string, focus?: string): Promise<TaskView> {
    const conversation = await this.runtime.require(taskId)
    const meta = await this.deps.db.getTaskMeta(taskId)
    if (!meta) throw new Error('Task not found.')
    await this.watch(taskId)
    this.deps.settings.setLastTask(taskId)
    const state = await conversation.viewState(CONTEXT)
    try {
      const entries = mapEntries(state.value.entries)
      if (this.active) this.active.entries = entries
      let start = Math.max(0, entries.length - INITIAL_ENTRIES)
      if (focus) {
        const index = entries.findIndex((entry) => entry.id === focus)
        if (index >= 0) start = Math.max(0, index - 20)
      }
      const slice = entries.slice(start)
      return {
        task: (await this.summary(taskId))!,
        entries: slice,
        live: this.liveOf(state.value, taskId),
        hasOlder: start > 0,
        cursor: slice[0]?.id ?? null,
        usage: usageOf(state.value),
        model: parseTaskModel(meta.model_json),
      }
    } finally {
      state.dispose()
    }
  }

  async older(
    taskId: string,
    before: string,
  ): Promise<{ entries: UiEntry[]; hasOlder: boolean; cursor: string | null }> {
    if (!this.active || this.active.id !== taskId)
      return { entries: [], hasOlder: false, cursor: null }
    const index = this.active.entries.findIndex((entry) => entry.id === before)
    if (index <= 0) return { entries: [], hasOlder: false, cursor: null }
    const start = Math.max(0, index - INITIAL_ENTRIES)
    const slice = this.active.entries.slice(start, index)
    return { entries: slice, hasOlder: start > 0, cursor: slice[0]?.id ?? null }
  }

  /** The search rows of a task, from the same projection the window renders. */
  async index(taskId: string): Promise<void> {
    // The last assistant message can land in the active watch a beat before
    // the durable view; keep the longer projection so search sees the answer.
    const durable = await this.runtime.entries(taskId)
    const watched =
      this.active?.id === taskId && this.active.entries.length > durable.length
        ? this.active.entries
        : durable
    await this.deps.db.replaceSearchDocs(taskId, searchRows(watched))
  }

  emitTask(taskId: string): void {
    void this.summary(taskId).then((task) => {
      if (task) this.deps.emit({ type: 'task', task })
    })
  }

  async refreshList(): Promise<void> {
    this.deps.emit({ type: 'tasks', tasks: await this.list() })
  }

  async close(): Promise<void> {
    if (this.active) await this.active.watch.stop().catch(() => undefined)
    await this.graphWatch?.stop().catch(() => undefined)
  }

  private liveOf(view: ConversationView, taskId: string): Live | null {
    return this.live.map(view, taskId)
  }

  private stateOf(taskId: string): TaskSummary['state'] {
    const nodes = Object.values(this.graph).filter((node) => node.conversationId === taskId)
    if (nodes.some((node) => node.status && node.status !== 'done')) return 'working'
    if (this.runtime.failed.has(taskId)) return 'attention'
    return 'ready'
  }

  private async watch(taskId: string): Promise<void> {
    if (this.active?.id === taskId) return
    if (this.active) await this.active.watch.stop().catch(() => undefined)
    const conversation = await this.runtime.require(taskId)
    const watch = await conversation.watch(CONTEXT)
    const active: ActiveWatch = { id: taskId, watch, seen: new Set(), entries: [] }
    this.active = active
    for (const entry of mapEntries(watch.value.entries)) active.seen.add(entry.id)
    let lastUsage = JSON.stringify(usageOf(watch.value))
    await watch.start(async (value) => {
      if (this.active !== active) return
      const mapped = mapEntries(value.entries)
      active.entries = mapped
      for (const entry of mapped) {
        if (active.seen.has(entry.id)) continue
        active.seen.add(entry.id)
        this.deps.emit({ type: 'entry', taskId, entry })
      }
      this.deps.emit({ type: 'live', taskId, live: this.liveOf(value, taskId) })
      const usage = usageOf(value)
      const serialized = JSON.stringify(usage)
      if (serialized !== lastUsage) {
        lastUsage = serialized
        this.deps.emit({ type: 'usage', taskId, usage })
      }
      this.emitTask(taskId)
    })
    this.deps.emit({ type: 'live', taskId, live: this.liveOf(watch.value, taskId) })
  }

  private watchGraph(): void {
    void this.runtime.pi
      .watchTaskGraph(CONTEXT)
      .then((watch) => {
        this.graphWatch = watch
        const apply = (value: TaskGraph) => {
          this.graph = (value.tasks ?? {}) as unknown as typeof this.graph
          const working = new Set(
            Object.values(this.graph)
              .filter((node) => node.status && node.status !== 'done' && node.conversationId)
              .map((node) => node.conversationId),
          )
          this.deps.working?.(working.size)
          void this.refreshList()
        }
        apply(watch.value)
        watch.start(async (value) => apply(value))
      })
      .catch(() => undefined)
  }

  private async backfillSearch(): Promise<void> {
    for (const id of await this.deps.db.conversationsWithoutSearch())
      await this.index(id).catch(() => undefined)
  }
}
