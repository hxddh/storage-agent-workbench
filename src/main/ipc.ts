import { stat, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AccountInput, AppSettings, ModelInput, ThinkingLevel } from '@shared/contract'
import { dialog, ipcMain, nativeTheme, shell } from 'electron'
import type { App } from './app'
import { awsProfiles } from './providers'

const PROVIDERS = new Set(['openai', 'anthropic', 'compatible'])
const THINKING = new Set<ThinkingLevel>(['off', 'low', 'medium', 'high'])
const MAX_ATTACHMENT = 4 * 1024 * 1024 * 1024

export function registerIpc(app: App): void {
  ipcMain.handle('agent:bootstrap', () => app.bootstrap())

  ipcMain.handle('agent:openTask', (_event, id: string, focus?: string) =>
    app.harness.openTask(id, focus),
  )
  ipcMain.handle('agent:older', (_event, id: string, before: string) =>
    app.harness.older(id, before),
  )

  ipcMain.handle('agent:createTask', async (_event, text: string, tokens: string[]) => {
    const id = await app.harness.newTask(text)
    const files = await app.staging.consume(tokens, id, app.uploadsFor(id))
    await app.harness.submit(id, text, files)
    return app.harness.openTask(id)
  })

  ipcMain.handle('agent:send', async (_event, taskId: string, text: string, tokens: string[]) => {
    const files = await app.staging.consume(tokens, taskId, app.uploadsFor(taskId))
    await app.harness.submit(taskId, text, files)
  })

  ipcMain.handle('agent:steer', (_event, taskId: string, text: string) =>
    app.harness.steer(taskId, text),
  )
  ipcMain.handle('agent:stop', (_event, taskId: string) => app.harness.stop(taskId))
  ipcMain.handle('agent:renameTask', (_event, id: string, title: string) =>
    app.harness.rename(id, title),
  )
  ipcMain.handle('agent:deleteTask', (_event, id: string) => app.harness.deleteTask(id))
  ipcMain.handle('agent:retryTask', (_event, id: string) => app.harness.retry(id))
  ipcMain.handle('agent:continueTask', (_event, id: string) => app.harness.continueTask(id))
  ipcMain.handle('agent:search', (_event, query: string) => app.harness.search(query))

  ipcMain.handle(
    'agent:saveText',
    async (_event, input: { name: string; content: string; kind: 'markdown' | 'csv' }) => {
      if (typeof input?.content !== 'string' || input.content.length > 10 * 1024 * 1024)
        return false
      const extension = input.kind === 'csv' ? 'csv' : 'md'
      const result = await dialog.showSaveDialog({
        title: 'Save',
        defaultPath: input.name.endsWith(`.${extension}`)
          ? input.name
          : `${input.name}.${extension}`,
        filters: [
          input.kind === 'csv'
            ? { name: 'CSV', extensions: ['csv'] }
            : { name: 'Markdown', extensions: ['md'] },
        ],
      })
      if (result.canceled || !result.filePath) return false
      await writeFile(result.filePath, input.content, 'utf8')
      return true
    },
  )

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
    const keyRef = input.apiKey?.trim() ? app.vault.seal(input.apiKey.trim()) : existing?.keyRef
    if (!keyRef) throw new Error('An API key is required.')
    app.settings.setModel({
      provider: input.provider,
      modelId,
      baseUrl: input.baseUrl?.trim() ?? '',
      contextWindow:
        input.contextWindow && input.contextWindow > 0
          ? Math.min(Math.round(input.contextWindow), 10_000_000)
          : 128_000,
      thinking: input.thinking && THINKING.has(input.thinking) ? input.thinking : 'off',
      keyRef,
    })
    app.applyModel()
  })

  ipcMain.handle('agent:clearModel', async () => {
    app.settings.setModel(null)
    app.applyModel()
  })

  ipcMain.handle('agent:testModel', () => app.testModel())

  ipcMain.handle('agent:saveSettings', async (_event, patch: Partial<AppSettings>) => {
    app.settings.patch(patch)
    if (patch.language) app.harness.setLanguage(patch.language)
    if (patch.theme) nativeTheme.themeSource = patch.theme
  })

  ipcMain.handle('agent:notes', () => app.harness.notes())

  ipcMain.handle('agent:deleteNote', (_event, id: string) => app.harness.deleteNote(id))

  ipcMain.handle('agent:openExternal', (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })
}
