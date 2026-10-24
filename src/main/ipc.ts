import { writeFile } from 'node:fs/promises'
import type { AccountInput, AppSettings } from '@shared/contract'
import { dialog, ipcMain, nativeTheme, shell } from 'electron'
import type { App } from './app'
import type { ModelProvider } from './settings'

export function registerIpc(app: App): void {
  ipcMain.handle('agent:bootstrap', () => app.bootstrap())

  ipcMain.handle('agent:openTask', (_event, id: string, focus?: string) =>
    app.harness.openTask(id, focus),
  )
  ipcMain.handle('agent:older', (_event, id: string, before: string) =>
    app.harness.older(id, before),
  )

  ipcMain.handle('agent:createTask', async (_event, text: string, tokens: string[]) => {
    const id = await app.harness.newTask(text, 'user')
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

  ipcMain.handle(
    'agent:saveModel',
    async (
      _event,
      input: {
        provider: ModelProvider
        modelId: string
        apiKey?: string
        baseUrl?: string
        contextWindow?: number
      },
    ) => {
      const existing = app.settings.get().model
      const keyRef = input.apiKey?.trim() ? app.vault.seal(input.apiKey.trim()) : existing?.keyRef
      if (!keyRef) throw new Error('An API key is required.')
      app.settings.setModel({
        provider: input.provider,
        modelId: input.modelId.trim(),
        baseUrl: input.baseUrl?.trim() ?? '',
        contextWindow: input.contextWindow ?? 32_768,
        keyRef,
      })
      app.applyModel()
    },
  )

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

  ipcMain.handle(
    'agent:setWatch',
    async (_event, providerId: string, patch: { enabled?: boolean; intervalHours?: number }) => {
      await app.db.setWatch(providerId, patch)
    },
  )

  ipcMain.handle('agent:runWatch', (_event, providerId: string) => app.runWatch(providerId))

  ipcMain.handle('agent:openExternal', (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })
}
