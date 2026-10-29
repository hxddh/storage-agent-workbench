import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { AppEvent, Bootstrap, ModelInput, TaskSummary, UpdateState } from '@shared/contract'
import { app } from 'electron'
import { AppDb } from './db'
import { Estate } from './estate/estate'
import { Providers } from './providers'
import { Engine } from './runtime/engine'
import { createModelSet, testModel, testModelDraft } from './runtime/model'
import { isScheduleDue } from './runtime/schedule'
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
  estate!: Estate
  settings!: Settings
  vault!: Vault
  runtime!: Runtime
  tasks!: Tasks
  engine!: Engine
  staging!: Staging
  update: UpdateState = { state: 'idle' }
  /** Set by the shell once an update is downloaded. */
  installUpdate?: () => void
  private database!: Database
  private dataDir = ''
  private readonly models = createModelSet()
  private scheduleTimer: ReturnType<typeof setInterval> | null = null
  private scheduleBusy = false
  private readonly scheduleAttempts = new Map<string, string>()
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
    this.estate = new Estate(this.db)
    this.staging = new Staging(join(dataDir, 'staging'))
    await this.staging.clear()

    this.runtime = await Runtime.open(this.database, {
      db: this.db,
      providers: this.providers,
      estate: this.estate,
      settings: this.settings,
      vault: this.vault,
      models: this.models,
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
    this.startSchedules()
  }

  /** Opt-in checks run only while the app process is open. */
  private startSchedules(): void {
    if (this.scheduleTimer) return
    this.scheduleTimer = setInterval(() => void this.runScheduled(), 60_000)
    this.scheduleTimer.unref?.()
    void this.runScheduled()
  }

  private async runScheduled(): Promise<void> {
    if (this.scheduleBusy) return
    this.scheduleBusy = true
    try {
      for (const account of await this.providers.list()) {
        if (!isScheduleDue(account.schedule, undefined)) continue
        const last = (await this.db.listReadings({ providerId: account.id, limit: 1 }))[0]
        if (!isScheduleDue(account.schedule, last?.at ?? this.scheduleAttempts.get(account.id)))
          continue
        this.scheduleAttempts.set(account.id, new Date().toISOString())
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
        const title = `${this.settings.get().language === 'zh' ? '定期检查' : 'Scheduled check'} · ${account.name} · ${stamp}`
        // A scheduled check is a message to the agent; without a model there is no check.
        if (!this.settings.get().model) continue
        const zh = this.settings.get().language === 'zh'
        const text = zh
          ? `检查存储账号 ${account.name}：读取所有存储桶，说明有哪些风险，以及哪些内容没能读到。`
          : `Check the storage account ${account.name}: read every bucket, tell me which risks are open, and what you could not read.`
        const taskId = await this.tasks.newTask(title)
        await this.engine.submit(
          taskId,
          text,
          [],
          [{ kind: 'account', providerId: account.id, label: account.name }],
        )
        await this.tasks.waitForIdle(taskId)
      }
    } catch {
      // A scheduled read must never take down the window. Its task page keeps
      // any failure it wrote; the next interval can try again.
    } finally {
      this.scheduleBusy = false
    }
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
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    this.scheduleTimer = null
    await this.tasks?.close().catch(() => undefined)
    await this.runtime?.close().catch(() => undefined)
    await this.database?.close().catch(() => undefined)
  }
}
