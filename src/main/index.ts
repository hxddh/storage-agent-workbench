import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AppCommand,
  type AppEvent,
  TASK_LINK_PREFIX,
  type TaskSummary,
} from '@shared/contract'
import { app, BrowserWindow, crashReporter, Menu, Notification, nativeTheme, shell } from 'electron'
import { App } from './app'
import { registerIpc } from './ipc'
import type { RunOutcome } from './runtime/session'
import { startUpdater } from './updater'
import { loadWindowBounds, saveWindowBounds } from './window-state'

const here = dirname(fileURLToPath(import.meta.url))
let pendingLink: string | null = null

/** Open `storage-agent://task/<id>`; queued until the window can show it. */
function openLink(url: string | undefined): void {
  if (!url?.startsWith(TASK_LINK_PREFIX)) return
  const taskId = url.slice(TASK_LINK_PREFIX.length).replace(/[/?#].*$/, '')
  if (!/^\d+$/.test(taskId)) return
  if (!mainWindow) {
    pendingLink = taskId
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  broadcast({ type: 'open', taskId })
}

// Crash dumps stay on disk; nothing is uploaded. A packaged build can export them.
crashReporter.start({ uploadToServer: false, compress: true })

app.on('open-url', (event, url) => {
  event.preventDefault()
  openLink(url)
})
const service = new App()

if (process.env.STORAGE_AGENT_DATA_DIR) {
  app.setPath('userData', process.env.STORAGE_AGENT_DATA_DIR)
}
let mainWindow: BrowserWindow | null = null

function broadcast(event: AppEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('agent:event', event)
  }
}

function sendCommand(command: AppCommand): void {
  mainWindow?.webContents.send('agent:command', command)
}

const NOTICE = {
  en: { answered: 'Answered', failed: 'The agent hit an error', stopped: 'Stopped' },
  zh: { answered: '已完成', failed: 'Agent 出错了', stopped: '已停止' },
}

/** Tell the user a run finished, only when they are looking elsewhere. */
async function notifySettled(task: TaskSummary, outcome: RunOutcome): Promise<void> {
  if (outcome === 'stopped' || !service.settings.get().notify) return
  if (mainWindow?.isFocused() || !Notification.isSupported()) return
  // A scheduled run tells the user only through the agent's own notify.
  if (await service.isScheduled(task.id)) return
  const words = NOTICE[service.settings.get().language] ?? NOTICE.en
  const notification = new Notification({
    title: task.title,
    body: words[outcome],
    silent: false,
    actions: [{ type: 'button', text: 'Open' }],
  })
  const open = () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    broadcast({ type: 'open', taskId: task.id })
  }
  notification.on('click', open)
  notification.on('action', open)
  notification.show()
}

/** A notification the agent sent; it opens its task, and the window if it is closed. */
function notifyFromAgent(taskId: string, title: string, body: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, silent: false })
  notification.on('click', async () => {
    if (!mainWindow) await createWindow()
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    broadcast({ type: 'open', taskId })
  })
  notification.show()
}

/** A badge on macOS, an indeterminate taskbar bar elsewhere, while anything runs. */
function showWorking(count: number): void {
  if (process.platform === 'darwin') app.setBadgeCount(count)
  else mainWindow?.setProgressBar(count > 0 ? 2 : -1, { mode: 'indeterminate' })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendCommand('settings'),
              },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'Task',
      submenu: [
        {
          label: 'New task',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendCommand('new-task'),
        },
        {
          label: 'Search tasks',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendCommand('search'),
        },
        {
          label: 'Stop',
          accelerator: 'CmdOrCtrl+.',
          click: () => sendCommand('stop'),
        },
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendCommand('settings'),
              },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(process.env.NODE_ENV === 'development' ? [{ role: 'toggleDevTools' as const }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow(): Promise<void> {
  const userData = app.getPath('userData')
  const bounds = loadWindowBounds(userData)
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 520,
    minHeight: 520,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12110f' : '#f7f5ef',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    ...(process.platform === 'darwin'
      ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const }
      : process.platform === 'win32'
        ? { backgroundMaterial: 'mica' as const }
        : {}),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    if (bounds.maximized) mainWindow?.maximize()
    mainWindow?.show()
  })
  mainWindow.on('close', () => {
    if (!mainWindow) return
    saveWindowBounds(userData, {
      ...mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized(),
    })
  })
  if (process.env.STORAGE_AGENT_SMOKE) {
    mainWindow.webContents.on('console-message', (_event, _level, message) => {
      console.log('[renderer]', message)
    })
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
      console.log('[load-failed]', code, description)
    })
    setTimeout(() => {
      console.log('SMOKE_OK')
      app.quit()
    }, 6000)
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Model prose can contain links. Never navigate the trusted window to one.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    await mainWindow.loadURL(devUrl)
  } else {
    await mainWindow.loadFile(join(here, '../renderer/index.html'))
  }
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

if (process.argv.includes('--mcp')) {
  // Headless: another agent talks to Storage Agent over stdio. No window, no
  // single-instance lock (the window may be open too), no model.
  app.dock?.hide()
  app
    .whenReady()
    .then(async () => {
      const { startMcp } = await import('./mcp')
      await startMcp(app.getPath('userData'), app.getVersion())
    })
    .catch((error) => {
      process.stderr.write(
        `storage-agent --mcp: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      app.exit(1)
    })
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', async (_event, argv) => {
    // Running in the background with no window: launching again opens it.
    if (!mainWindow) await createWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    openLink(argv.find((arg) => arg.startsWith(TASK_LINK_PREFIX)))
  })

  app.whenReady().then(async () => {
    app.setName('Storage Agent')
    await service.init(app.getPath('userData'))
    service.setHooks({
      emit: broadcast,
      settled: (task, outcome) => void notifySettled(task, outcome),
      working: showWorking,
      notify: notifyFromAgent,
    })
    nativeTheme.themeSource = service.settings.get().theme
    registerIpc(service)
    buildMenu()
    if (!process.env.STORAGE_AGENT_DATA_DIR) app.setAsDefaultProtocolClient('storage-agent')
    // Started at login: no window, schedules run; launching the app again opens it.
    if (!process.argv.includes('--background')) await createWindow()
    startUpdater(service)
    const link = pendingLink ?? process.argv.find((arg) => arg.startsWith(TASK_LINK_PREFIX))
    pendingLink = null
    if (link)
      mainWindow?.webContents.once('did-finish-load', () =>
        openLink(link.startsWith(TASK_LINK_PREFIX) ? link : `${TASK_LINK_PREFIX}${link}`),
      )

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return
    // With work scheduled, or set to run at login, the app stays in the background.
    void service
      .hasScheduledWork()
      .then((stay) => {
        if (!stay) app.quit()
      })
      .catch(() => app.quit())
  })

  app.on('before-quit', () => {
    void service.dispose()
  })
}
