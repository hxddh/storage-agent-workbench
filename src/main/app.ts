import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { AppEvent, Bootstrap, ModelInput, TaskSummary, UpdateState } from '@shared/contract'
import { app } from 'electron'
import { AppDb } from './db'
import { MemoryStore } from './memory'
import { Providers } from './providers'
import { Engine } from './runtime/engine'
import { createModelSet, testModel, testModelDraft } from './runtime/model'
import { type RunOutcome, Runtime, runtimeDirs } from './runtime/session'
import { Tasks } from './runtime/tasks'
import { Vault } from './security/vault'
import { Settings } from './settings'
import { Staging } from './staging'

type Database = Awaited<ReturnType<typeof openNodeSqliteDatabase>>

export interface ShellHooks {
  emit: (event: AppEvent) => void
  settled: (task: TaskSummary, outcome: RunOutcome) => void
  working: (count: number) => void
}

export class App {
  db!: AppDb
  providers!: Providers
  settings!: Settings
  vault!: Vault
  runtime!: Runtime
  tasks!: Tasks
  engine!: Engine
  staging!: Staging
  memory!: MemoryStore
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
      await mkdir(join(dataDir, 'tasks'), { recursive: true })
      this.settings.setLastTask(null)
    }
    this.vault = new Vault(dataDir)
    this.providers = new Providers(this.db, this.vault)
    this.staging = new Staging(join(dataDir, 'staging'))
    await this.staging.clear()
    // Memory outlives tasks and app versions; documents of tasks a reset cleared go with them.
    this.memory = MemoryStore.open(join(dataDir, 'memory.sqlite'))
    if (this.db.resetTasks) this.memory.forgetTasks()

    this.runtime = await Runtime.open(this.database, {
      db: this.db,
      providers: this.providers,
      settings: this.settings,
      vault: this.vault,
      models: this.models,
      memory: this.memory,
      dirs: runtimeDirs(dataDir),
      emit: (event) => this.hooks.emit(event),
      settled: (task, outcome) => this.hooks.settled(task, outcome),
      working: (count) => this.hooks.working(count),
    })
    this.tasks = new Tasks(this.runtime)
    this.engine = new Engine(this.runtime, this.tasks)
    this.tasks.start()
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
      settings: this.settings.public(),
      update: this.update,
      lastTaskId: lastTaskId && tasks.some((task) => task.id === lastTaskId) ? lastTaskId : null,
    }
  }

  async testModel(input?: ModelInput): Promise<{ ok: boolean; detail: string }> {
    const stored = this.settings.get().model
    const result = input
      ? await testModelDraft(this.models, input, stored, this.vault)
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
    this.memory?.close()
  }
}
