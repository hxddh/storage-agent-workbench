import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  type Conversation,
  type ConversationView,
  createRegistry,
  type EntryRecord,
  Harness,
  type TaskGraph,
  type WatchHandle,
} from '@earendil-works/pi-durable'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import { briefSearchText, buildBrief } from '@shared/brief'
import type {
  AppEvent,
  AttachmentRef,
  Live,
  LiveTool,
  NoteRow,
  SearchHit,
  TaskSummary,
  TaskView,
  ToolName,
  UiEntry,
} from '@shared/contract'
import type { AppDb } from '../db'
import type { Estate } from '../estate/estate'
import type { Providers } from '../providers'
import type { Vault } from '../security/vault'
import type { Settings } from '../settings'
import type { ToolDeps } from '../tools/policy'
import { type AgentState, createAgent, refreshDigest } from './agent'
import { createModelSet, installModel } from './model'

const CONTEXT = BACKGROUND_CONTEXT
const INITIAL_ENTRIES = 200

export interface HarnessDirs {
  task: (conversationId: string) => string
  datasets: (conversationId: string) => string
  uploads: (conversationId: string) => string
}

export interface HarnessDeps {
  db: AppDb
  providers: Providers
  estate: Estate
  settings: Settings
  vault: Vault
  dirs: HarnessDirs
  emit: (event: AppEvent) => void
}

interface ActiveWatch {
  id: string
  watch: WatchHandle<ConversationView>
  seen: Set<string>
  liveSince: string | null
  entries: UiEntry[]
}

function textOf(message: AssistantMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}

export class AgentHarness {
  private readonly state: AgentState = { digest: '', language: 'en', rounds: new Map() }
  private active: ActiveWatch | null = null
  private graphWatch: WatchHandle<TaskGraph> | null = null
  private graphTasks: Record<string, { conversationId?: string; status?: string }> = {}
  private liveStarted = new Map<string, string>()
  private toolStarted = new Map<string, string>()

  private constructor(
    private readonly deps: HarnessDeps,
    private readonly harness: Harness,
  ) {}

  static async open(database: NodeSqliteDatabase, deps: HarnessDeps): Promise<AgentHarness> {
    const storage = await SqliteStorage.open(database, { prefix: 'pi_' })
    const db = deps.db

    const models = createModelSet()
    const stored = deps.settings.get().model
    let modelRef: { provider: string; modelId: string } | null = null
    if (stored) {
      try {
        modelRef = installModel(models, stored, deps.vault)
      } catch {
        modelRef = null
      }
    }

    const fullDeps: HarnessDeps = deps
    const state = { digest: '', language: deps.settings.get().language, rounds: new Map() }
    const toolDeps: ToolDeps = {
      db,
      providers: deps.providers,
      estate: deps.estate,
      datasetsDir: deps.dirs.datasets,
      uploadsDir: deps.dirs.uploads,
      lang: () => deps.settings.get().language,
    }
    const registry = createRegistry()
    registry.install(createAgent(toolDeps, state))

    const harness = await Harness.open(storage, { models, registry }, CONTEXT)
    const instance = new AgentHarness(fullDeps, harness)
    instance.state.digest = state.digest
    instance.state.language = state.language
    instance.state.rounds = state.rounds
    instance.modelRef = modelRef
    instance.models = models
    await refreshDigest(toolDeps, instance.state)
    instance.watchGraph()
    void instance.rebuildSearch()
    return instance
  }

  private modelRef: { provider: string; modelId: string } | null = null
  private models: ReturnType<typeof createModelSet> | null = null

  get db(): AppDb {
    return this.deps.db
  }

  async refreshEstateDigest(): Promise<void> {
    await refreshDigest(
      {
        db: this.deps.db,
        providers: this.deps.providers,
        estate: this.deps.estate,
        datasetsDir: this.deps.dirs.datasets,
        uploadsDir: this.deps.dirs.uploads,
        lang: () => this.deps.settings.get().language,
      },
      this.state,
    )
  }

  setLanguage(language: string): void {
    this.state.language = language
    const toolDeps: ToolDeps = {
      db: this.deps.db,
      providers: this.deps.providers,
      estate: this.deps.estate,
      datasetsDir: this.deps.dirs.datasets,
      uploadsDir: this.deps.dirs.uploads,
      lang: () => this.deps.settings.get().language,
    }
    void refreshDigest(toolDeps, this.state)
  }

  applyModel(): void {
    const stored = this.deps.settings.get().model
    if (!stored || !this.models) {
      this.modelRef = null
      return
    }
    this.modelRef = installModel(this.models, stored, this.deps.vault)
  }

  hasModel(): boolean {
    return Boolean(this.deps.settings.get().model)
  }

  // -- tasks ----------------------------------------------------------------

  async newTask(text: string): Promise<string> {
    const conversation = await this.newConversation()
    const id = String(conversation.id)
    const title = deriveTitle(text)
    await this.deps.db.upsertTaskMeta({ conversationId: id, title })
    await this.refreshTaskList()
    return id
  }

  async waitForIdle(taskId: string): Promise<void> {
    const conversation = await this.conversation(taskId)
    await conversation?.waitForIdle(CONTEXT)
  }

  async submit(taskId: string, text: string, attachments: AttachmentRef[]): Promise<void> {
    const conversation = await this.conversation(taskId)
    if (!conversation) throw new Error('Task not found.')
    this.state.rounds.delete(taskId)
    await this.deps.db.touchTask(taskId)
    await this.submitTo(conversation, text, attachments)
  }

  async steer(taskId: string, text: string): Promise<void> {
    const conversation = await this.conversation(taskId)
    if (!conversation) throw new Error('Task not found.')
    const submission = await conversation.submit(
      {
        type: 'input',
        content: text,
        whenBusy: 'steer',
        entry: { kind: 'sa.user', data: { text, attachments: [] } },
      },
      CONTEXT,
    )
    void this.settle(conversation, taskId, submission)
  }

  async stop(taskId: string): Promise<void> {
    const conversation = await this.conversation(taskId)
    if (!conversation) return
    await conversation.abort(CONTEXT)
    await conversation
      .submit(
        {
          type: 'write',
          entry: {
            kind: 'sa.notice',
            data: { text: 'Stopped.', tone: 'info', action: 'continue' },
          },
        },
        CONTEXT,
      )
      .catch(() => undefined)
  }

  async retry(taskId: string): Promise<void> {
    const text = await this.lastUserText(taskId)
    if (!text) throw new Error('There is nothing to retry.')
    const conversation = await this.conversation(taskId)
    if (!conversation) throw new Error('Task not found.')
    this.state.rounds.delete(taskId)
    await this.submitTo(conversation, text, [])
  }

  async continueTask(taskId: string): Promise<void> {
    const conversation = await this.conversation(taskId)
    if (!conversation) throw new Error('Task not found.')
    this.state.rounds.delete(taskId)
    await this.submitTo(conversation, 'Continue from where you stopped.', [])
  }

  async search(query: string): Promise<SearchHit[]> {
    const q = query.trim()
    if (!q) return []
    const needle = q.toLowerCase()
    const tasks = await this.deps.db.listTaskMeta()
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
    for (const doc of await this.deps.db.searchDocs(q, 300)) {
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

  async notes(): Promise<NoteRow[]> {
    const rows = await this.deps.db.listNotes({ limit: 100 })
    return rows.map((note) => ({
      id: note.id,
      scope: note.scope,
      ref: note.ref,
      text: note.text,
      author: note.author,
      createdAt: note.created_at,
    }))
  }

  async deleteNote(id: string): Promise<void> {
    await this.deps.db.deleteNote(id)
    await this.refreshEstateDigest()
  }

  async rename(taskId: string, title: string): Promise<void> {
    const clean = title.trim().slice(0, 120)
    if (!clean) return
    const meta = await this.deps.db.getTaskMeta(taskId)
    if (!meta) return
    await this.deps.db.upsertTaskMeta({
      conversationId: taskId,
      title: clean,
      createdAt: meta.created_at,
    })
    await this.refreshTaskList()
  }

  async deleteTask(taskId: string): Promise<void> {
    if (this.active?.id === taskId) {
      await this.active.watch.stop()
      this.active = null
    }
    const conversation = await this.conversation(taskId)
    if (conversation) await conversation.abort(CONTEXT).catch(() => undefined)
    await this.deps.db.deleteTaskMeta(taskId)
    await this.deps.db.deleteSearchDocs(taskId)
    await this.deps.db.purgeTask(taskId)
    await rm(this.deps.dirs.task(taskId), { recursive: true, force: true }).catch(() => undefined)
    await this.refreshTaskList()
  }

  async listTasks(): Promise<TaskSummary[]> {
    const rows = await this.deps.db.listTaskMeta()
    const out: TaskSummary[] = []
    for (const row of rows) {
      out.push({
        id: row.conversation_id,
        title: row.title,
        state: this.stateOf(row.conversation_id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    }
    return out
  }

  async openTask(taskId: string, focus?: string): Promise<TaskView> {
    const conversation = await this.conversation(taskId)
    if (!conversation) throw new Error('Task not found.')
    const meta = await this.deps.db.getTaskMeta(taskId)
    if (!meta) throw new Error('Task not found.')
    await this.startWatch(conversation, taskId)
    const state = await conversation.viewState(CONTEXT)
    try {
      const entries = mapEntries(state.value.entries)
      this.active!.entries = entries
      const live = this.mapLive(state.value, taskId)
      let start = Math.max(0, entries.length - INITIAL_ENTRIES)
      if (focus) {
        const index = entries.findIndex((entry) => entry.id === focus)
        if (index >= 0) start = Math.max(0, index - 20)
      }
      const slice = entries.slice(start)
      return {
        task: {
          id: taskId,
          title: meta.title,
          state: this.stateOf(taskId),
          createdAt: meta.created_at,
          updatedAt: meta.updated_at,
        },
        entries: slice,
        live,
        hasOlder: start > 0,
        cursor: slice[0]?.id ?? null,
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

  async close(): Promise<void> {
    if (this.active) await this.active.watch.stop().catch(() => undefined)
    await this.graphWatch?.stop().catch(() => undefined)
    await this.harness.close(CONTEXT)
  }

  // -- internals ------------------------------------------------------------

  private async conversation(id: string): Promise<Conversation | null> {
    try {
      return (await this.harness.conversation(id as never, CONTEXT)) ?? null
    } catch {
      return null
    }
  }

  private async newConversation(): Promise<Conversation> {
    const agent = this.modelRef ? { model: this.modelRef } : undefined
    return this.harness.createConversation(
      { ownership: { kind: 'ownerless' }, ...(agent ? { agent } : {}) } as never,
      CONTEXT,
    )
  }

  private async submitTo(
    conversation: Conversation,
    text: string,
    attachments: AttachmentRef[],
  ): Promise<void> {
    const content = attachments.length
      ? `${text}\n\n[attached files: ${attachments.map((file) => file.name).join(', ')}]`
      : text
    const submission = await conversation.submit(
      {
        type: 'input',
        content,
        entry: {
          kind: 'sa.user',
          data: { text, attachments } as never,
        },
      },
      CONTEXT,
    )
    void this.settle(conversation, String(conversation.id), submission)
  }

  private async settle(
    conversation: Conversation,
    taskId: string,
    submission: { wait(context: typeof CONTEXT): Promise<{ status: string; reason?: string }> },
  ): Promise<void> {
    try {
      const settled = await submission.wait(CONTEXT)
      if (settled.status === 'unanswered' && settled.reason !== 'aborted') {
        const reason = settled.reason ? ` (${settled.reason})` : ''
        await conversation.submit(
          {
            type: 'write',
            entry: {
              kind: 'sa.notice',
              data: {
                text: `The run ended without an answer${reason}.`,
                tone: 'error',
                action: 'retry',
              },
            },
          },
          CONTEXT,
        )
      }
    } catch (error) {
      await conversation
        .submit(
          {
            type: 'write',
            entry: {
              kind: 'sa.notice',
              data: {
                text: `The run failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
                tone: 'error',
              },
            },
          },
          CONTEXT,
        )
        .catch(() => undefined)
    } finally {
      await this.deps.db.touchTask(taskId)
      await this.refreshTaskList()
      await this.indexConversation(taskId).catch(() => undefined)
      await refreshDigest(
        {
          db: this.deps.db,
          providers: this.deps.providers,
          estate: this.deps.estate,
          datasetsDir: this.deps.dirs.datasets,
          uploadsDir: this.deps.dirs.uploads,
          lang: () => this.deps.settings.get().language,
        },
        this.state,
      )
      void taskId
    }
  }

  private async startWatch(conversation: Conversation, taskId: string): Promise<void> {
    if (this.active?.id === taskId) return
    if (this.active) await this.active.watch.stop().catch(() => undefined)
    const watch = await conversation.watch(CONTEXT)
    const active: ActiveWatch = {
      id: taskId,
      watch,
      seen: new Set(),
      liveSince: null,
      entries: [],
    }
    this.active = active
    const initial = watch.value
    for (const entry of mapEntries(initial.entries)) active.seen.add(entry.id)
    await watch.start(async (value) => {
      if (this.active !== active) return
      const mapped = mapEntries(value.entries)
      active.entries = mapped
      for (const entry of mapped) {
        if (active.seen.has(entry.id)) continue
        active.seen.add(entry.id)
        this.deps.emit({ type: 'entry', taskId, entry })
      }
      this.deps.emit({ type: 'live', taskId, live: this.mapLive(value, taskId) })
      this.emitTask(taskId)
    })
    this.deps.emit({ type: 'live', taskId, live: this.mapLive(initial, taskId) })
  }

  private mapLive(view: ConversationView, taskId: string): Live | null {
    const live = view.docs['pi.live'] as
      | {
          run?: unknown
          generation?: { message?: AssistantMessage }
          tools?: {
            callId: string
            name: string
            status: string
            output?: string
            details?: { target?: string }
          }[]
        }
      | undefined
    if (!live?.run) {
      this.liveStarted.delete(taskId)
      this.toolStarted.clear()
      return null
    }
    const startedAt = this.liveStarted.get(taskId) ?? new Date().toISOString()
    this.liveStarted.set(taskId, startedAt)
    const tools: LiveTool[] = []
    const seen = new Set<string>()
    for (const slot of live.tools ?? []) {
      if (slot.status === 'done') continue
      seen.add(slot.callId)
      const since = this.toolStarted.get(slot.callId) ?? new Date().toISOString()
      this.toolStarted.set(slot.callId, since)
      tools.push({
        callId: slot.callId,
        name: slot.name as ToolName,
        target: String(slot.details?.target ?? ''),
        note: lastLine(slot.output),
        startedAt: since,
      })
    }
    for (const callId of [...this.toolStarted.keys()]) {
      if (!seen.has(callId)) this.toolStarted.delete(callId)
    }
    const text = live.generation?.message ? textOf(live.generation.message) : ''
    return {
      phase: tools.length ? 'tool' : text ? 'writing' : 'thinking',
      tools,
      text: text || null,
      startedAt,
    }
  }

  private async lastUserText(taskId: string): Promise<string | null> {
    const conversation = await this.conversation(taskId)
    if (!conversation) return null
    const state = await conversation.viewState(CONTEXT)
    try {
      for (let index = state.value.entries.length - 1; index >= 0; index -= 1) {
        const entry = state.value.entries[index]!
        if (entry.kind !== 'sa.user') continue
        const data = entry.data as { text?: string } | undefined
        if (data?.text) return data.text
      }
      return null
    } finally {
      state.dispose()
    }
  }

  private async indexConversation(taskId: string): Promise<void> {
    const conversation = await this.conversation(taskId)
    if (!conversation) return
    const state = await conversation.viewState(CONTEXT)
    try {
      const mapped = mapEntries(state.value.entries)
      const docs: { entryId: string; kind: string; text: string; at: string }[] = []
      for (const entry of mapped) {
        if (entry.kind === 'user') {
          docs.push({ entryId: entry.id, kind: 'user', text: entry.text, at: entry.at })
        }
      }
      docs.push(...briefSearchText(buildBrief(mapped)))
      await this.deps.db.replaceSearchDocs(taskId, docs)
    } finally {
      state.dispose()
    }
  }

  private async rebuildSearch(): Promise<void> {
    const ids = await this.deps.db.conversationsWithoutSearch()
    for (const id of ids) {
      await this.indexConversation(id).catch(() => undefined)
    }
  }

  private stateOf(taskId: string): TaskSummary['state'] {
    const nodes = Object.values(this.graphTasks).filter((node) => node.conversationId === taskId)
    if (nodes.some((node) => node.status && node.status !== 'done')) return 'working'
    if (this.active?.id === taskId) {
      const last = this.active.entries.at(-1)
      if (last?.kind === 'notice' && last.tone === 'error') return 'attention'
    }
    return 'ready'
  }

  private watchGraph(): void {
    void this.harness
      .watchTaskGraph(CONTEXT)
      .then((watch) => {
        this.graphWatch = watch
        const apply = (value: TaskGraph) => {
          this.graphTasks = (value.tasks ?? {}) as unknown as Record<
            string,
            { conversationId?: string; status?: string }
          >
          void this.refreshTaskList()
        }
        apply(watch.value)
        watch.start(async (value) => {
          apply(value)
        })
      })
      .catch(() => undefined)
  }

  private emitTask(taskId: string): void {
    void this.deps.db.getTaskMeta(taskId).then((meta) => {
      if (!meta) return
      this.deps.emit({
        type: 'task',
        task: {
          id: taskId,
          title: meta.title,
          state: this.stateOf(taskId),
          createdAt: meta.created_at,
          updatedAt: meta.updated_at,
        },
      })
    })
  }

  private async refreshTaskList(): Promise<void> {
    this.deps.emit({ type: 'tasks', tasks: await this.listTasks() })
  }
}

function cleanResult(text: string): string {
  return text
    .replace(/<\/?harness>/gi, ' ')
    .replace(/\[\/?error\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

function lastLine(output: string | undefined): string | null {
  if (!output) return null
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines.at(-1)
  return last ? last.slice(0, 90) : null
}

function deriveTitle(text: string): string {
  const first = text.trim().split('\n')[0] ?? ''
  const clean = first
    .replace(/[#*`_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'New task'
  return clean.length > 64 ? `${clean.slice(0, 61)}…` : clean
}

export function mapEntries(entries: readonly EntryRecord[]): UiEntry[] {
  const out: UiEntry[] = []
  const toolNames = new Map<string, string>()
  for (const entry of entries) {
    const id = String(entry.id)
    if (entry.kind === 'pi.user' || entry.kind === 'sa.user') {
      const data = entry.data as { text?: string; attachments?: AttachmentRef[] } | undefined
      let text = data?.text ?? ''
      const message = entry.model?.[0] as
        | { role?: string; content?: unknown; timestamp?: number }
        | undefined
      if (!text && message?.role === 'user') {
        text =
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      }
      out.push({
        id,
        kind: 'user',
        at: message?.timestamp ? new Date(message.timestamp).toISOString() : '',
        text,
        attachments: data?.attachments ?? [],
      })
      continue
    }
    if (entry.kind === 'pi.assistant') {
      const message = entry.model?.[0] as AssistantMessage | undefined
      if (!message) continue
      for (const part of message.content) {
        if (part.type === 'toolCall') toolNames.set(part.id, part.name)
      }
      const text = textOf(message)
      if (text) {
        out.push({
          id,
          kind: 'answer',
          at: message.timestamp ? new Date(message.timestamp).toISOString() : '',
          text,
        })
      } else if (message.stopReason === 'error' && message.errorMessage) {
        out.push({
          id,
          kind: 'notice',
          at: '',
          text: message.errorMessage.slice(0, 300),
          tone: 'error',
        })
      }
      continue
    }
    if (entry.kind === 'pi.tool-result') {
      const message = entry.model?.[0] as ToolResultMessage | undefined
      if (!message) continue
      const details = message.details as
        | {
            target?: string
            note?: string | null
            view?: UiEntry extends { kind: 'tool'; view: infer V } ? V : never
            ms?: number
          }
        | undefined
      const resultText = cleanResult(
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join(' '),
      )
      const aborted = /aborted/i.test(resultText)
      const timedOut = /timed out/i.test(resultText)
      out.push({
        id,
        kind: 'tool',
        at: message.timestamp ? new Date(message.timestamp).toISOString() : '',
        name: (message.toolName ?? toolNames.get(message.toolCallId) ?? 'estate') as ToolName,
        target: details?.target ?? '',
        status: aborted ? 'stopped' : message.isError ? 'failed' : 'done',
        note:
          details?.note ??
          (aborted
            ? null
            : timedOut
              ? 'Timed out'
              : message.isError && resultText
                ? resultText
                : null),
        ms: message.durationMs ?? details?.ms ?? null,
        view: (details?.view as never) ?? null,
        callId: message.toolCallId,
      })
      continue
    }
    if (entry.kind === 'pi.compaction') {
      out.push({ id, kind: 'compaction', at: '', text: 'Earlier turns were compacted.' })
      continue
    }
    if (entry.kind === 'sa.notice') {
      const data = entry.data as
        | { text?: string; tone?: 'info' | 'warn' | 'error'; action?: 'retry' | 'continue' }
        | undefined
      out.push({
        id,
        kind: 'notice',
        at: '',
        text: data?.text ?? '',
        tone: data?.tone ?? 'info',
        ...(data?.action ? { action: data.action } : {}),
      })
    }
  }
  return out
}

export function harnessDirs(dataDir: string): HarnessDirs {
  return {
    task: (conversationId) => join(dataDir, 'tasks', conversationId),
    datasets: (conversationId) => join(dataDir, 'tasks', conversationId, 'datasets'),
    uploads: (conversationId) => join(dataDir, 'tasks', conversationId, 'uploads'),
  }
}
