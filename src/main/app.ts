import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { AppEvent, Bootstrap } from '@shared/contract'
import { app } from 'electron'
import { AppDb } from './db'
import { Estate } from './estate/estate'
import { Providers } from './providers'
import { AgentHarness, harnessDirs } from './runtime/harness'
import { createModelSet, installModel, testModel } from './runtime/model'
import { Vault } from './security/vault'
import { Settings } from './settings'
import { Staging } from './staging'

type Database = Awaited<ReturnType<typeof openNodeSqliteDatabase>>

export class App {
  db!: AppDb
  providers!: Providers
  estate!: Estate
  settings!: Settings
  vault!: Vault
  harness!: AgentHarness
  staging!: Staging
  private database!: Database
  private dataDir = ''
  private emit: (event: AppEvent) => void = () => undefined
  private models = createModelSet()

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

    const stored = this.settings.get().model
    if (stored) {
      try {
        installModel(this.models, stored, this.vault)
      } catch {
        // A broken model setting must not stop the app; Settings shows the error.
      }
    }

    this.harness = await AgentHarness.open(this.database, {
      db: this.db,
      providers: this.providers,
      estate: this.estate,
      settings: this.settings,
      vault: this.vault,
      dirs: harnessDirs(dataDir),
      emit: (event) => this.emit(event),
    })
  }

  setEmit(emit: (event: AppEvent) => void): void {
    this.emit = emit
  }

  async bootstrap(): Promise<Bootstrap> {
    return {
      version: app.getVersion(),
      platform: process.platform,
      tasks: await this.harness.listTasks(),
      accounts: await this.providers.list(),
      model: this.settings.get().model
        ? {
            provider: this.settings.get().model!.provider,
            modelId: this.settings.get().model!.modelId,
            baseUrl: this.settings.get().model!.baseUrl || null,
            contextWindow: this.settings.get().model!.contextWindow || null,
            hasKey: true,
          }
        : null,
      settings: this.settings.public(),
    }
  }

  async testModel(): Promise<{ ok: boolean; detail: string }> {
    const stored = this.settings.get().model
    if (!stored) return { ok: false, detail: 'No model is configured.' }
    return testModel(this.models, stored, this.vault)
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
