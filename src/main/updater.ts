import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { App } from './app'

const { autoUpdater } = electronUpdater
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

function missingFeed(error: unknown): boolean {
  const text = `${(error as { code?: string })?.code ?? ''} ${
    error instanceof Error ? error.message : String(error)
  }`
  return /latest(-mac|-linux)?\.yml|channel file.*not found|404/i.test(text)
}

/**
 * Background updates from GitHub releases. Packaged builds only; a failure is
 * silent (an unsigned macOS build cannot update itself, and that is not the
 * user's problem to read about). A downloaded update installs on quit, or now
 * from the one quiet line in Settings.
 */
export function startUpdater(service: App): void {
  if (!app.isPackaged || process.env.STORAGE_AGENT_NO_UPDATE) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  autoUpdater.on('update-available', (info) =>
    service.setUpdate({ state: 'downloading', version: info.version }),
  )
  autoUpdater.on('update-downloaded', (info) => {
    service.installUpdate = () => autoUpdater.quitAndInstall()
    service.setUpdate({ state: 'ready', version: info.version })
  })
  autoUpdater.on('error', (error) => {
    if (service.update.state === 'downloading') service.setUpdate({ state: 'idle' })
    if (missingFeed(error) && service.update.state !== 'ready')
      service.setUpdate({ state: 'unavailable' })
  })
  const check = () =>
    void autoUpdater.checkForUpdates().catch((error) => {
      if (missingFeed(error) && service.update.state !== 'ready')
        service.setUpdate({ state: 'unavailable' })
    })
  check()
  setInterval(check, CHECK_EVERY_MS).unref()
}
