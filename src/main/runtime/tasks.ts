/**
 * The task list and the open task.
 *
 * A task is a pi conversation plus a title row. This keeps the sidebar, the one
 * watched task, the search index and the user's own acts on memory. Runs
 * belong to the engine.
 */
import { rm } from 'node:fs/promises'
import type { ConversationView, TaskGraph, WatchHandle } from '@earendil-works/pi-durable'
import type {
  ContextRef,
  Live,
  SearchHit,
  StorageRef,
  TaskModel,
  TaskSummary,
  TaskView,
  UiEntry,
  Usage,
} from '@shared/contract'
import { searchRows } from '@shared/conversation'
import { deriveTitle, LiveTracker, mapEntries, usageOf } from './project'
import { searchTasks } from './search'
import { CONTEXT, parseTaskModel, type Runtime } from './session'

const INITIAL_ENTRIES = 200

interface ActiveWatch {
  id: string
  watch: WatchHandle<ConversationView>
  view: ConversationView
  seen: Set<string>
  entries: UiEntry[]
}

export class Tasks {
  private readonly live = new LiveTracker()
  private active: ActiveWatch | null = null
  /** What a finished child agent spent; a running one is read again. */
  private readonly childSpend = new Map<string, Usage | null>()
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

  async datasetRows() {
    return (await this.deps.db.listUserDatasets()).map((row) => ({
      id: row.id,
      name: row.name,
      rows: row.rows,
      bytes: row.bytes,
      source: row.source,
      createdAt: row.created_at,
    }))
  }

  async deleteDataset(id: string): Promise<void> {
    const row = await this.deps.db.getDataset(id)
    if (row?.scope !== 'user') return
    await this.deps.db.deleteDataset(id)
    await rm(row.path, { force: true }).catch(() => undefined)
  }

  /** What the workspace holds, for the window. */
  workspaceEntries() {
    return this.runtime.tools.workspace?.list('', 8) ?? []
  }

  async deleteWorkspacePath(path: string): Promise<void> {
    this.runtime.tools.workspace?.delete(path)
    await this.runtime.refreshDigest()
  }

  /** The workspace folder, so the window can open it. */
  workspaceFolder(): string {
    return this.runtime.deps.dirs.workspace
  }

  /** Bundled skills and the workspace's own, each with where it came from. */
  skills() {
    const skills = this.runtime.tools.workspace?.skills
    return [...(skills?.bundled() ?? []), ...(skills?.user() ?? [])]
  }

  /** The views pinned to the board. */
  board() {
    return this.runtime.tools.workspace?.board() ?? []
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
    // A schedule's runs live in its task; deleting the task ends the schedule.
    for (const row of await this.deps.db.listSchedules())
      if (row.conversation_id === taskId) await this.deps.db.deleteSchedule(row.id)
    await this.deps.db.deleteSearchDocs(taskId)
    const purged = await this.deps.db.purgeTask(taskId)
    for (const id of purged) {
      await rm(this.deps.dirs.task(id), { recursive: true, force: true }).catch(() => undefined)
    }
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
    const active = this.active
    if (!active) throw new Error('Task not found.')

    let entries: UiEntry[]
    let hasOlder: boolean
    if (focus) {
      // A search hit or citation jumps to a known entry: read the history it
      // belongs to, then show from a little before it through the newest.
      const all = await this.runtime.entries(taskId)
      const index = all.findIndex((entry) => entry.id === focus)
      const start = index >= 0 ? Math.max(0, index - 20) : Math.max(0, all.length - INITIAL_ENTRIES)
      entries = all.slice(start)
      hasOlder = start > 0
    } else {
      // The newest page only. The watch adds what arrives; older pages are a
      // separate read, so a long task never has to sit in memory whole.
      const page = await conversation.entries(
        { order: 'descending' },
        INITIAL_ENTRIES + 1,
        undefined,
        CONTEXT,
      )
      const ordered = mapEntries([...page.items].reverse())
      hasOlder = Boolean(page.next) || ordered.length > INITIAL_ENTRIES
      entries = ordered.slice(-INITIAL_ENTRIES)
    }
    // An entry can commit while the page is read. It is already in the watch's
    // projection; keep it after the page instead of assigning it away.
    const seen = new Set(entries.map((entry) => entry.id))
    for (const entry of active.entries) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      entries.push(entry)
    }
    active.entries = entries
    for (const entry of entries) active.seen.add(entry.id)
    return {
      task: (await this.summary(taskId))!,
      entries,
      live: this.liveOf(active.view, taskId),
      hasOlder,
      cursor: entries[0]?.id ?? null,
      usage: await this.usage(active.view, entries),
      model: parseTaskModel(meta.model_json),
    }
  }

  /**
   * What a task spent: its own model calls and every delegated child's, so
   * the user sees the whole cost of the work they asked for.
   */
  private async usage(view: ConversationView, entries: UiEntry[]): Promise<Usage | null> {
    let total = usageOf(view)
    for (const entry of entries) {
      if (entry.kind !== 'tool' || entry.view?.kind !== 'delegate') continue
      const child = entry.view.conversationId
      let spent = this.childSpend.get(child)
      if (spent === undefined || entry.view.status === 'running') {
        spent = await this.conversationUsage(child)
        if (entry.view.status !== 'running') this.childSpend.set(child, spent)
      }
      if (!spent) continue
      total ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 }
      total = {
        input: total.input + spent.input,
        output: total.output + spent.output,
        cacheRead: total.cacheRead + spent.cacheRead,
        cacheWrite: total.cacheWrite + spent.cacheWrite,
        reasoning: total.reasoning + spent.reasoning,
        cost: total.cost + spent.cost,
      }
    }
    return total
  }

  /** Whether the user has this task open in the window: a run there is attended. */
  isWatched(taskId: string): boolean {
    return this.active?.id === taskId
  }

  /** Input and output tokens a task's own model calls have used so far. */
  async spentTokens(taskId: string): Promise<number> {
    const usage = await this.conversationUsage(taskId)
    return usage ? usage.input + usage.output : 0
  }

  private async conversationUsage(id: string): Promise<Usage | null> {
    try {
      const conversation = await this.runtime.conversation(id)
      if (!conversation) return null
      const watch = await conversation.watch(CONTEXT, { min: 1, max: 1 })
      const usage = usageOf(watch.value)
      await watch.stop()
      return usage
    } catch {
      return null
    }
  }

  /** A delegated child conversation, as the window renders it. */
  async childEntries(conversationId: string): Promise<UiEntry[]> {
    if (!/^\d+$/.test(String(conversationId))) return []
    return this.runtime.entries(String(conversationId))
  }

  async older(
    taskId: string,
    before: string,
  ): Promise<{ entries: UiEntry[]; hasOlder: boolean; cursor: string | null }> {
    if (!this.active || this.active.id !== taskId)
      return { entries: [], hasOlder: false, cursor: null }
    const conversation = await this.runtime.require(taskId)
    const page = await conversation.entries(
      { order: 'descending', maxEntryId: before as never },
      INITIAL_ENTRIES + 1,
      undefined,
      CONTEXT,
    )
    const items = page.items
      .filter((entry) => String(entry.id) !== before)
      .slice(0, INITIAL_ENTRIES)
    const entries = mapEntries([...items].reverse())
    for (const entry of entries) this.active.seen.add(entry.id)
    this.active.entries = [...entries, ...this.active.entries]
    return { entries, hasOlder: Boolean(page.next), cursor: entries[0]?.id ?? before }
  }

  /** The search rows of a task, from the same projection the window renders. */
  async index(taskId: string): Promise<void> {
    const durable = await this.runtime.entries(taskId)
    await this.deps.db.replaceSearchDocs(taskId, searchRows(durable))
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
    // A window, not the whole transcript: a long task costs the same to watch
    // as a short one. `open`/`older` read the pages the user actually asks for.
    const watch = await conversation.watch(CONTEXT, { min: 100, max: 200 })
    const active: ActiveWatch = {
      id: taskId,
      watch,
      view: watch.value,
      seen: new Set(),
      entries: [],
    }
    this.active = active
    const initial = mapEntries(watch.value.entries)
    active.entries = initial
    for (const entry of initial) active.seen.add(entry.id)
    let lastUsage = JSON.stringify(await this.usage(watch.value, initial))
    await watch.start(async (call) => {
      if (this.active !== active || call.kind !== 'value') return
      const value = call.value
      active.view = value
      const mapped = mapEntries(value.entries)
      for (const entry of mapped) {
        if (active.seen.has(entry.id)) continue
        active.seen.add(entry.id)
        active.entries.push(entry)
        this.deps.emit({ type: 'entry', taskId, entry })
      }
      this.deps.emit({ type: 'live', taskId, live: this.liveOf(value, taskId) })
      const usage = await this.usage(value, active.entries)
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
        watch.start(async (call) => {
          if (call.kind === 'value') apply(call.value)
        })
      })
      .catch(() => undefined)
  }

  private async backfillSearch(): Promise<void> {
    for (const id of await this.deps.db.conversationsWithoutSearch())
      await this.index(id).catch(() => undefined)
  }
}
