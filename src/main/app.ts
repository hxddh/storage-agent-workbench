import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type {
  AppEvent,
  Bootstrap,
  EstateOverview,
  OverviewSuggestion,
  TaskSummary,
  UpdateState,
} from '@shared/contract'
import { app } from 'electron'
import { AppDb } from './db'
import { Estate } from './estate/estate'
import { Providers } from './providers'
import { AgentHarness, harnessDirs, type RunOutcome } from './runtime/harness'
import { createModelSet, testModel } from './runtime/model'
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
  harness!: AgentHarness
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
    this.vault = new Vault(dataDir)
    this.providers = new Providers(this.db, this.vault)
    this.estate = new Estate(this.db)
    this.staging = new Staging(join(dataDir, 'staging'))
    await this.staging.clear()

    this.harness = await AgentHarness.open(this.database, {
      db: this.db,
      providers: this.providers,
      estate: this.estate,
      settings: this.settings,
      vault: this.vault,
      models: this.models,
      dirs: harnessDirs(dataDir),
      emit: (event) => this.hooks.emit(event),
      settled: (task, outcome) => this.hooks.settled(task, outcome),
      working: (count) => this.hooks.working(count),
    })
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
    const tasks = await this.harness.listTasks()
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
      overview: await this.overview(),
      update: this.update,
      lastTaskId: lastTaskId && tasks.some((task) => task.id === lastTaskId) ? lastTaskId : null,
    }
  }

  markHomeSeen(): void {
    this.settings.markSeen()
  }

  /** A quiet account summary: no dashboard, no chart, no per-bucket table. */
  async overview(): Promise<EstateOverview> {
    const accounts = await this.providers.list()
    const seen = this.settings.get().lastSeenAt
    const summary = []
    const suggestions: OverviewSuggestion[] = []
    let lastRead: string | null = null
    let changesSince = 0
    const suggest = (item: OverviewSuggestion) => {
      if (
        suggestions.some(
          (existing) => existing.code === item.code && existing.bucket === item.bucket,
        )
      )
        return
      if (suggestions.length < 3) suggestions.push(item)
    }
    for (const account of accounts) {
      const buckets = await this.db.listBuckets(account.id)
      const read = buckets.map((row) => row.posture_at).filter((at): at is string => Boolean(at))
      const newest = read.sort().at(-1) ?? null
      if (newest && (!lastRead || newest > lastRead)) lastRead = newest
      const openTotal = await this.db.countOpenIssues(account.id)
      const openHigh = await this.db.countOpenHigh(account.id)
      if (seen) changesSince += await this.db.countOpenedSince(account.id, seen)
      summary.push({
        id: account.id,
        name: account.name,
        kind: account.kind,
        buckets: buckets.length,
        lastRead: newest,
        openHigh,
        openTotal,
      })
      if (buckets.length === 0 && openTotal === 0) {
        suggest({ code: 'survey', bucket: '' })
        suggest({ code: 'public', bucket: '' })
      }
      const issues = await this.db.listIssues({
        providerId: account.id,
        status: 'open',
        limit: 100,
      })
      for (const issue of issues) {
        if (!issue.bucket) continue
        const code =
          issue.code === 'public_exposure'
            ? 'access'
            : issue.code === 'insecure_transport'
              ? 'tls'
              : issue.code === 'no_default_encryption'
                ? 'key'
                : issue.code === 'large_standard_only' ||
                    issue.code === 'no_abort_mpu' ||
                    issue.code === 'noncurrent_never_expire'
                  ? 'cleanup'
                  : 'principals'
        suggest({ code, bucket: issue.bucket })
      }
    }
    if (suggestions.length < 3) suggest({ code: 'changes', bucket: '' })
    return { accounts: summary, lastRead, changesSince, suggestions: suggestions.slice(0, 3) }
  }

  async testModel(): Promise<{ ok: boolean; detail: string }> {
    const stored = this.settings.get().model
    if (!stored) return { ok: false, detail: 'No model is configured.' }
    const result = await testModel(this.models, stored, this.vault)
    this.harness.applyModel()
    return result
  }

  applyModel(): void {
    this.harness.applyModel()
  }

  uploadsFor(conversationId: string): string {
    return join(this.dataDir, 'tasks', conversationId, 'uploads')
  }

  async dispose(): Promise<void> {
    await this.harness?.close().catch(() => undefined)
    await this.database?.close().catch(() => undefined)
  }
}
