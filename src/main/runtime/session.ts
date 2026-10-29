/**
 * The durable base the engine and the task list share.
 *
 * pi owns the durable loop: storage, resume, steering, abort, compaction and
 * tool tasks. This opens it once, installs the one extension, and answers the
 * questions both sides ask: which conversation, which entries, which model.
 * Nothing that decides a run's behaviour is kept here in memory; the
 * extension rebuilds what it needs from the entries.
 */
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { createModels } from '@earendil-works/pi-ai'
import {
  type Conversation,
  createRegistry,
  type EntryRecord,
  Harness,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import type { AppEvent, TaskModel, TaskSummary, UiEntry } from '@shared/contract'
import type { AppDb } from '../db'
import type { MemoryStore } from '../memory'
import type { Providers } from '../providers'
import type { Vault } from '../security/vault'
import type { Settings } from '../settings'
import { createTools } from '../tools'
import type { ToolDeps } from '../tools/policy'
import { buildDigest, createAgent } from './agent'
import { mapEntries } from './project'

export const CONTEXT = BACKGROUND_CONTEXT

export interface RuntimeDirs {
  task: (conversationId: string) => string
  datasets: (conversationId: string) => string
  uploads: (conversationId: string) => string
}

export type RunOutcome = 'answered' | 'failed' | 'stopped'

export interface RuntimeDeps {
  db: AppDb
  providers: Providers
  settings: Settings
  vault: Vault
  models: ReturnType<typeof createModels>
  memory: MemoryStore
  dirs: RuntimeDirs
  emit: (event: AppEvent) => void
  /** A run settled; the shell decides whether to notify. */
  settled?: (task: TaskSummary, outcome: RunOutcome) => void
  /** How many tasks are running, for the dock and taskbar. */
  working?: (count: number) => void
}

export function runtimeDirs(dataDir: string): RuntimeDirs {
  return {
    task: (conversationId) => join(dataDir, 'tasks', conversationId),
    datasets: (conversationId) => join(dataDir, 'tasks', conversationId, 'datasets'),
    uploads: (conversationId) => join(dataDir, 'tasks', conversationId, 'uploads'),
  }
}

export function parseTaskModel(raw: string | null | undefined): TaskModel | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<TaskModel>
    if (
      typeof value.modelId !== 'string' ||
      !value.modelId.trim() ||
      !['anthropic', 'openai', 'compatible'].includes(String(value.provider)) ||
      !['off', 'low', 'medium', 'high'].includes(String(value.thinking))
    )
      return null
    return {
      provider: value.provider as TaskModel['provider'],
      modelId: value.modelId.slice(0, 160),
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl.slice(0, 300) : null,
      thinking: value.thinking as TaskModel['thinking'],
    }
  } catch {
    return null
  }
}

export class Runtime {
  /** Tasks whose last run failed; the sidebar marks them. */
  readonly failed = new Set<string>()
  private digest = ''

  private constructor(
    readonly deps: RuntimeDeps,
    readonly pi: Harness,
    readonly tools: ToolDeps,
    readonly registry: ToolRegistration[],
  ) {}

  static async open(database: NodeSqliteDatabase, deps: RuntimeDeps): Promise<Runtime> {
    const storage = await SqliteStorage.open(database, { prefix: 'pi_' })
    const tools: ToolDeps = {
      db: deps.db,
      providers: deps.providers,
      taskDir: deps.dirs.task,
      datasetsDir: deps.dirs.datasets,
      uploadsDir: deps.dirs.uploads,
      memory: deps.memory,
      lang: () => deps.settings.get().language,
    }
    const list = createTools(tools)
    let runtime: Runtime | null = null
    const registry = createRegistry()
    registry.install(
      createAgent(
        tools,
        {
          digest: () => runtime?.digest ?? '',
          language: () => deps.settings.get().language,
        },
        list,
      ),
    )
    const pi = await Harness.open(
      storage,
      {
        models: () => deps.models,
        registry,
        // Cache the stable prompt prefix where the provider supports it.
        settings: { stream: { cacheRetention: 'short' } },
      },
      CONTEXT,
    )
    runtime = new Runtime(deps, pi, tools, list)
    tools.entries = (id) => runtime!.entries(id)
    // The vault stays closed at launch: on macOS it can prompt for Keychain
    // access, which belongs to the first model run. The digest is one query.
    await runtime.refreshDigest()
    return runtime
  }

  async refreshDigest(): Promise<void> {
    this.digest = await buildDigest(this.tools)
  }

  async conversation(id: string): Promise<Conversation | null> {
    try {
      return (await this.pi.conversation(id as never, CONTEXT)) ?? null
    } catch {
      return null
    }
  }

  async require(id: string): Promise<Conversation> {
    const conversation = await this.conversation(id)
    if (!conversation) throw new Error('Task not found.')
    return conversation
  }

  /** The conversation's durable entries; the source of every run's ledger. */
  async records(id: string): Promise<readonly EntryRecord[] | null> {
    const conversation = await this.conversation(id)
    if (!conversation) return null
    const state = await conversation.viewState(CONTEXT)
    try {
      return state.value.entries
    } finally {
      state.dispose()
    }
  }

  async entries(id: string): Promise<UiEntry[]> {
    return mapEntries((await this.records(id)) ?? [])
  }

  /** The model this task runs with: its own choice, or the one in Settings. */
  async taskModel(id: string): Promise<TaskModel | null> {
    return parseTaskModel((await this.deps.db.getTaskMeta(id))?.model_json)
  }

  /** Append an entry the model does not answer: a notice. */
  async write(
    conversation: Conversation,
    kind: string,
    data: unknown,
    model?: { role: 'user'; content: string; timestamp: number }[],
  ): Promise<void> {
    await conversation.submit(
      {
        type: 'write',
        entry: { kind, data: data as never, ...(model ? { model: model as never } : {}) },
      },
      CONTEXT,
    )
  }

  async close(): Promise<void> {
    await this.pi.close(CONTEXT)
  }
}
