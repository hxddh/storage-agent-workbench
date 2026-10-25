import { stat, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  AccountInput,
  AppSettings,
  ContextRef,
  ModelInput,
  ThinkingLevel,
} from '@shared/contract'
import { BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import type { App } from './app'
import { detectLocalModels } from './local-models'
import { contextFor, listModels, thinkingFor } from './model-catalog'
import { awsProfiles } from './providers'

const PROVIDERS = new Set(['openai', 'anthropic', 'compatible'])
const THINKING = new Set<ThinkingLevel>(['off', 'low', 'medium', 'high'])
const MAX_ATTACHMENT = 4 * 1024 * 1024 * 1024

export function registerIpc(app: App): void {
  ipcMain.handle('agent:bootstrap', () => app.bootstrap())

  ipcMain.handle('agent:openTask', (_event, id: string, focus?: string) =>
    app.harness.openTask(id, focus),
  )

  ipcMain.handle('agent:audit', async () => {
    const accounts = await app.providers.list()
    if (accounts.length === 0) throw new Error('Choose a storage account first.')
    const lang = app.settings.get().language
    const names = accounts
      .slice(0, 2)
      .map((account) => account.name)
      .join(', ')
    const title = `${lang === 'zh' ? '检查' : 'Check'} · ${names} · ${new Date()
      .toISOString()
      .slice(0, 10)}`
    const id = await app.harness.newTask(title)
    // Return the task immediately; progress and the durable result arrive
    // through the task watch instead of making the window wait for the sweep.
    void app.harness.audit(id).catch(() => undefined)
    return app.harness.openTask(id)
  })
  ipcMain.handle('agent:older', (_event, id: string, before: string) =>
    app.harness.older(id, before),
  )

  ipcMain.handle(
    'agent:createTask',
    async (_event, text: string, tokens: string[], context?: ContextRef[]) => {
      const id = await app.harness.newTask(text)
      const files = await app.staging.consume(tokens, id, app.uploadsFor(id))
      await app.harness.submit(id, text, files, context)
      return app.harness.openTask(id)
    },
  )

  ipcMain.handle(
    'agent:send',
    async (_event, taskId: string, text: string, tokens: string[], context?: ContextRef[]) => {
      const files = await app.staging.consume(tokens, taskId, app.uploadsFor(taskId))
      await app.harness.submit(taskId, text, files, context)
    },
  )

  ipcMain.handle('agent:estateRefs', (_event, query: string) =>
    app.harness.estateRefs(String(query ?? '').slice(0, 120)),
  )

  ipcMain.handle('agent:steer', (_event, taskId: string, text: string) =>
    app.harness.steer(taskId, text),
  )
  ipcMain.handle('agent:stop', (_event, taskId: string) => app.harness.stop(taskId))
  ipcMain.handle('agent:renameTask', (_event, id: string, title: string) =>
    app.harness.rename(id, title),
  )
  ipcMain.handle('agent:pinTask', (_event, id: string, pinned: boolean) =>
    app.harness.pin(String(id), Boolean(pinned)),
  )
  ipcMain.handle('agent:deleteTask', (_event, id: string) => app.harness.deleteTask(id))
  ipcMain.handle('agent:retryTask', (_event, id: string) => app.harness.retry(id))
  ipcMain.handle('agent:continueTask', (_event, id: string) => app.harness.continueTask(id))
  ipcMain.handle('agent:reverifyTask', (_event, id: string) => app.harness.reverify(id))
  ipcMain.handle('agent:search', (_event, query: string) => app.harness.search(query))

  ipcMain.handle(
    'agent:saveText',
    async (_event, input: { name: string; content: string; kind: 'markdown' | 'csv' | 'json' }) => {
      if (typeof input?.content !== 'string' || input.content.length > 10 * 1024 * 1024)
        return false
      const extension = input.kind === 'csv' ? 'csv' : input.kind === 'json' ? 'json' : 'md'
      const result = await dialog.showSaveDialog({
        title: 'Save',
        defaultPath: input.name.endsWith(`.${extension}`)
          ? input.name
          : `${input.name}.${extension}`,
        filters: [
          input.kind === 'csv'
            ? { name: 'CSV', extensions: ['csv'] }
            : input.kind === 'json'
              ? { name: 'JSON', extensions: ['json'] }
              : { name: 'Markdown', extensions: ['md'] },
        ],
      })
      if (result.canceled || !result.filePath) return false
      await writeFile(result.filePath, input.content, 'utf8')
      return true
    },
  )

  ipcMain.handle('agent:exportPdf', async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window) return false
    const result = await dialog.showSaveDialog(window, {
      title: 'Save PDF',
      defaultPath: 'storage-agent-brief.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (result.canceled || !result.filePath) return false
    const pdf = await window.webContents.printToPDF({ printBackground: true })
    await writeFile(result.filePath, pdf)
    return true
  })

  ipcMain.handle('agent:pickFiles', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Attach a log or inventory',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Logs and inventories',
          extensions: ['log', 'txt', 'csv', 'tsv', 'jsonl', 'json', 'parquet', 'gz'],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled) return []
    return app.staging.stage(result.filePaths)
  })

  // Paths come from files the user dropped or pasted; the preload resolves them
  // with webUtils, which yields nothing for a file the page made up.
  ipcMain.handle('agent:stagePaths', async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return []
    const accepted: string[] = []
    for (const path of paths.slice(0, 10)) {
      if (typeof path !== 'string' || !isAbsolute(path)) continue
      const info = await stat(path).catch(() => null)
      if (info?.isFile() && info.size <= MAX_ATTACHMENT) accepted.push(path)
    }
    return app.staging.stage(accepted)
  })

  ipcMain.handle('agent:awsProfiles', () => awsProfiles())

  ipcMain.handle('agent:addDemoAccount', async () => {
    const account = await app.providers.addDemo()
    await app.harness.refreshEstateDigest()
    return account
  })

  ipcMain.handle('agent:localModels', () => detectLocalModels())

  ipcMain.handle('agent:acceptIssue', (_event, id: string, accepted: boolean) =>
    app.harness.acceptIssue(String(id), Boolean(accepted)),
  )

  ipcMain.handle('agent:installUpdate', () => app.installUpdate?.())

  ipcMain.handle('agent:saveAccount', async (_event, input: AccountInput) => {
    const account = await app.providers.save(input)
    await app.harness.refreshEstateDigest()
    return account
  })

  ipcMain.handle('agent:deleteAccount', async (_event, id: string) => {
    await app.providers.remove(id)
    await app.harness.refreshEstateDigest()
  })

  ipcMain.handle('agent:testAccount', (_event, id: string) => app.providers.test(id))

  ipcMain.handle('agent:saveModel', async (_event, input: ModelInput) => {
    if (!PROVIDERS.has(input.provider)) throw new Error('Unknown model provider.')
    const modelId = input.modelId?.trim()
    if (!modelId) throw new Error('A model id is required.')
    const existing = app.settings.get().model
    const key = input.apiKey?.trim()
    if (!key && existing && existing.provider !== input.provider)
      throw new Error('Enter an API key for this model provider.')
    const keyRef = key ? app.vault.seal(key) : existing?.keyRef
    if (!keyRef) throw new Error('An API key is required.')
    app.settings.setModel({
      provider: input.provider,
      modelId,
      baseUrl: input.baseUrl?.trim() ?? '',
      contextWindow:
        input.contextWindow && input.contextWindow > 0
          ? Math.min(Math.round(input.contextWindow), 10_000_000)
          : contextFor(modelId),
      thinking:
        input.thinking && THINKING.has(input.thinking)
          ? input.thinking
          : thinkingFor(modelId, input.provider),
      keyRef,
    })
    app.applyModel()
  })

  ipcMain.handle('agent:clearModel', async () => {
    app.settings.setModel(null)
    app.applyModel()
  })

  ipcMain.handle('agent:testModel', (_event, input?: ModelInput) => {
    if (input && !PROVIDERS.has(input.provider)) throw new Error('Unknown model provider.')
    return app.testModel(input)
  })

  ipcMain.handle(
    'agent:listModels',
    (
      _event,
      input: { provider: 'openai' | 'anthropic' | 'compatible'; baseUrl: string; apiKey?: string },
    ) => {
      if (!PROVIDERS.has(input?.provider)) throw new Error('Unknown model provider.')
      const stored = app.settings.get().model
      const key = input.apiKey?.trim() || (stored ? app.vault.open(stored.keyRef) : '')
      return listModels({
        provider: input.provider,
        baseUrl: String(input.baseUrl ?? ''),
        apiKey: key,
      })
    },
  )

  ipcMain.handle('agent:saveSettings', async (_event, patch: Partial<AppSettings>) => {
    app.settings.patch(patch)
    if (patch.language) app.harness.setLanguage(patch.language)
    if (patch.theme) nativeTheme.themeSource = patch.theme
  })

  ipcMain.handle('agent:markHomeSeen', () => app.markHomeSeen())

  ipcMain.handle('agent:notes', () => app.harness.notes())

  ipcMain.handle('agent:deleteNote', (_event, id: string) => app.harness.deleteNote(id))

  ipcMain.handle('agent:openExternal', (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })
}
