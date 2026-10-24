import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { App } from './app'

const { autoUpdater } = electronUpdater
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

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
  autoUpdater.on('error', () => {
    if (service.update.state === 'downloading') service.setUpdate({ state: 'idle' })
  })
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined)
  check()
  setInterval(check, CHECK_EVERY_MS).unref()
}
