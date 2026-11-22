import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { AppEvent, Bootstrap, ModelInput, TaskSummary, UpdateState } from '@shared/contract'
import { app } from 'electron'
import { AppDb } from './db'
import { importLegacy } from './legacy'
import { Providers } from './providers'
import { Engine } from './runtime/engine'
import { createModelSet, testModel, testModelDraft } from './runtime/model'
import { Scheduler } from './runtime/scheduler'
import { type RunOutcome, Runtime, runtimeDirs } from './runtime/session'
import { Tasks } from './runtime/tasks'
import { SERVICES } from './s3/api'
import { Vault } from './security/vault'
import { Settings } from './settings'
import { Staging } from './staging'
import type { AgentHost } from './tools/policy'

type Database = Awaited<ReturnType<typeof openNodeSqliteDatabase>>

export interface ShellHooks {
  emit: (event: AppEvent) => void
  settled: (task: TaskSummary, outcome: RunOutcome) => void
  working: (count: number) => void
  /** A notification the agent sent: shown by the system, opens its task. */
  notify?: (taskId: string, title: string, body: string) => void
}

export class App {
  db!: AppDb
  providers!: Providers
  settings!: Settings
  vault!: Vault
  runtime!: Runtime
  tasks!: Tasks
  engine!: Engine
  scheduler!: Scheduler
  staging!: Staging
  update: UpdateState = { state: 'idle' }
  /** Set by the shell once an update is downloaded. */
  installUpdate?: () => void
  private database!: Database
  private dataDir = ''
  private readonly models = createModelSet()
  private hooks: ShellHooks = {
    emit: () => undefined,
    settled: () => undefined,
    working: () => undefined,
  }

  async init(dataDir: string): Promise<void> {
    this.dataDir = dataDir
    await mkdir(join(dataDir, 'tasks'), { recursive: true })
    const { openNodeSqliteDatabase } = await import('@earendil-works/chord/sqlite/node')
    this.database = await openNodeSqliteDatabase(join(dataDir, 'storage-agent.db'))
    this.db = await AppDb.open(this.database)
    this.settings = new Settings(dataDir)
    if (this.db.resetTasks) {
      await rm(join(dataDir, 'tasks'), { recursive: true, force: true })
      await rm(join(dataDir, 'datasets'), { recursive: true, force: true })
      await mkdir(join(dataDir, 'tasks'), { recursive: true })
      this.settings.setLastTask(null)
    }
    this.vault = new Vault(dataDir)
    this.providers = new Providers(this.db, this.vault)
    this.staging = new Staging(join(dataDir, 'staging'))
    await this.staging.clear()
    this.runtime = await Runtime.open(this.database, {
      db: this.db,
      providers: this.providers,
      settings: this.settings,
      vault: this.vault,
      models: this.models,
      dirs: runtimeDirs(dataDir),
      emit: (event) => this.hooks.emit(event),
      settled: (task, outcome) => this.hooks.settled(task, outcome),
      working: (count) => this.hooks.working(count),
    })
    // 42.0.0's memory, methods and skills move into the workspace once.
    const workspace = this.runtime.tools.workspace
    if (workspace) await importLegacy(dataDir, this.db, workspace).catch(() => [])
    this.tasks = new Tasks(this.runtime)
    this.engine = new Engine(this.runtime, this.tasks)
    this.scheduler = new Scheduler(this.runtime, this.tasks, this.engine)
    this.runtime.scheduleHost = this.scheduler
    this.runtime.tools.host = this.agentHost()
    this.tasks.start()
  }

  /** Whether a task is a schedule's: its runs notify only when the agent says so. */
  async isScheduled(taskId: string): Promise<boolean> {
    return (await this.db.listSchedules()).some((row) => row.conversation_id === taskId)
  }

  /** What the app does for the agent's `self`, `schedule` and `notify` tools. */
  private agentHost(): AgentHost {
    // The input a run answered when it last notified, per task: one notification per run.
    const notified = new Map<string, string>()
    return {
      self: async (conversationId) => {
        const taskId = await this.db.rootConversation(conversationId)
        const stored = this.settings.get().model
        const chosen = await this.runtime.taskModel(taskId)
        const model = chosen ?? stored
        const usage = await this.tasks.spentTokens(taskId)
        const accounts = (await this.providers.list()).map((account) => ({
          name: account.name,
          id: account.id,
          endpoint: account.endpoint || 'AWS',
          region: account.region,
          signsInWith:
            account.auth === 'profile'
              ? `AWS profile ${account.profile ?? 'default'}`
              : 'access keys',
          scope: account.scope.buckets.length
            ? account.scope.buckets
            : 'every bucket the credentials can see',
          changesAllowed: Boolean((account as { allowChanges?: boolean }).allowChanges),
        }))
        return {
          model: model
            ? {
                provider: model.provider,
                id: model.modelId,
                contextWindow: this.runtime.windows.get(taskId) ?? stored?.contextWindow ?? null,
                thinking: model.thinking,
              }
            : null,
          thisTask: { id: taskId, tokensSpent: usage },
          accounts,
          schedules: await this.scheduler.list(),
          workspace: this.runtime.deps.dirs.workspace,
          appVersion: app.getVersion(),
          today: new Date().toISOString().slice(0, 10),
          services: SERVICES,
        }
      },
      rename: (taskId, title) => this.tasks.rename(taskId, title),
      pin: (taskId, pinned) => this.tasks.pin(taskId, pinned),
      schedules: {
        list: () => this.scheduler.list(),
        create: (input) => this.scheduler.create(input),
        cancel: (name) => this.scheduler.cancel(name),
      },
      notify: async (conversationId, title, body) => {
        const taskId = await this.db.rootConversation(conversationId)
        const entries = await this.runtime.entries(taskId)
        const lastInput = entries.findLast((entry) => entry.kind === 'user')?.id ?? 'none'
        if (notified.get(taskId) === lastInput)
          return {
            shown: false,
            reason: 'This run already notified the user; put everything in one notification.',
          }
        notified.set(taskId, lastInput)
        await this.db.addInbox({ conversationId: taskId, title, body })
        this.hooks.emit({ type: 'inbox' })
        if (!this.settings.get().notify)
          return {
            shown: false,
            reason: 'The user turned notifications off; it is in the inbox in the window.',
          }
        this.hooks.notify?.(taskId, title, body)
        return { shown: true }
      },
    }
  }

  setHooks(hooks: ShellHooks): void {
    this.hooks = hooks
  }

  setUpdate(update: UpdateState): void {
    this.update = update
    this.hooks.emit({ type: 'update', update })
  }

  async bootstrap(): Promise<Bootstrap> {
    const model = this.settings.get().model
    const lastTaskId = this.settings.get().lastTaskId
    const tasks = await this.tasks.list()
    return {
      version: app.getVersion(),
      platform: process.platform,
      tasks,
      accounts: await this.providers.list(),
      model: model
        ? {
            provider: model.provider,
            modelId: model.modelId,
            baseUrl: model.baseUrl || null,
            contextWindow: model.contextWindow || null,
            thinking: model.thinking,
            hasKey: true,
          }
        : null,
      savedModels: this.settings.get().models.map((item) => ({
        provider: item.provider,
        modelId: item.modelId,
        baseUrl: item.baseUrl || null,
        contextWindow: item.contextWindow,
        thinking: item.thinking,
      })),
      settings: this.settings.public(),
      update: this.update,
      lastTaskId: lastTaskId && tasks.some((task) => task.id === lastTaskId) ? lastTaskId : null,
    }
  }

  async testModel(input?: ModelInput): Promise<{ ok: boolean; detail: string }> {
    const stored = this.settings.get().model
    const result = input
      ? await testModelDraft(
          this.models,
          input,
          this.settings.keyFor(input.provider, input.baseUrl),
          this.vault,
        )
      : stored
        ? await testModel(this.models, stored, this.vault)
        : { ok: false, detail: 'No model is configured.' }
    return result
  }

  uploadsFor(conversationId: string): string {
    return join(this.dataDir, 'tasks', conversationId, 'uploads')
  }

  async dispose(): Promise<void> {
    await this.tasks?.close().catch(() => undefined)
    await this.runtime?.close().catch(() => undefined)
    await this.database?.close().catch(() => undefined)
  }
}
