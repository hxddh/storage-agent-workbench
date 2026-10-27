import type {
  AppEvent,
  AuditProgress,
  Bootstrap,
  ContextRef,
  LocalModel,
  TaskSummary,
  TaskView,
} from '@shared/contract'
import { Menu } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Composer } from './Composer'
import { Home } from './Home'
import { dict } from './i18n'
import type { SettingsPane } from './Settings'

// Settings is a sheet most launches never open; the run and its Markdown
// bundle load when a task opens. Home and the composer are the first paint.
const Settings = lazy(() => import('./Settings').then((module) => ({ default: module.Settings })))
const Run = lazy(() => import('./Run').then((module) => ({ default: module.Run })))

import { Sidebar } from './Sidebar'

function upsert(list: TaskSummary[], task: TaskSummary): TaskSummary[] {
  const index = list.findIndex((item) => item.id === task.id)
  if (index < 0) return [task, ...list]
  const next = [...list]
  next[index] = task
  return next
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [view, setView] = useState<TaskView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPane, setSettingsPane] = useState<SettingsPane>('model')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [fatal, setFatal] = useState(false)
  const [searchSignal, setSearchSignal] = useState(0)
  const [auditing, setAuditing] = useState(false)
  const [auditProgress, setAuditProgress] = useState<{
    taskId: string
    progress: AuditProgress
  } | null>(null)
  const [auditError, setAuditError] = useState<string | null>(null)
  const restored = useRef(false)

  const lang = boot?.settings.language ?? 'en'
  const t = useMemo(() => dict(lang), [lang])

  const refresh = useCallback(async () => {
    const next = await window.agent.bootstrap()
    setBoot(next)
    setTasks(next.tasks)
  }, [])

  useEffect(() => {
    if (!('agent' in window)) {
      setFatal(true)
      return
    }
    void refresh().catch(() => setFatal(true))
  }, [refresh])

  useEffect(() => {
    if (!('agent' in window)) return
    return window.agent.onEvent((event: AppEvent) => {
      if (event.type === 'tasks') setTasks(event.tasks)
      else if (event.type === 'task') {
        setTasks((current) => upsert(current, event.task))
        setView((current) =>
          current && current.task.id === event.task.id ? { ...current, task: event.task } : current,
        )
      } else if (event.type === 'entry') {
        setView((current) =>
          current && current.task.id === event.taskId
            ? { ...current, entries: [...current.entries, event.entry] }
            : current,
        )
      } else if (event.type === 'live') {
        setView((current) =>
          current && current.task.id === event.taskId ? { ...current, live: event.live } : current,
        )
      } else if (event.type === 'audit') {
        setAuditProgress(event.progress ? { taskId: event.taskId, progress: event.progress } : null)
        if (!event.progress) setAuditing(false)
      } else if (event.type === 'usage') {
        setView((current) =>
          current && current.task.id === event.taskId
            ? { ...current, usage: event.usage }
            : current,
        )
      } else if (event.type === 'issues') {
        setView((current) =>
          current
            ? { ...current, issueStatus: { ...current.issueStatus, ...event.statuses } }
            : current,
        )
      } else if (event.type === 'update') {
        setBoot((current) => (current ? { ...current, update: event.update } : current))
      } else if (event.type === 'open') {
        void openTaskRef.current(event.taskId)
      }
    })
  }, [])

  useEffect(() => {
    const apply = () => {
      const theme = boot?.settings.theme ?? 'system'
      const dark =
        theme === 'dark' ||
        (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [boot?.settings.theme])

  const openSettings = useCallback((pane: SettingsPane = 'model') => {
    setSettingsPane(pane)
    setSettingsOpen(true)
  }, [])

  const newTask = useCallback(() => {
    setView(null)
    setFocusId(null)
    setSidebarOpen(false)
    void refresh()
  }, [refresh])

  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    if (!('agent' in window)) return
    return window.agent.onCommand((command) => {
      if (command === 'settings') openSettings('model')
      if (command === 'new-task') newTask()
      if (command === 'search') {
        setSidebarOpen(true)
        setSearchSignal((n) => n + 1)
      }
      if (command === 'stop') {
        const current = viewRef.current
        if (current?.live) void window.agent.stop(current.task.id)
      }
      if (command === 'reverify') {
        const current = viewRef.current
        if (current && !current.live) void window.agent.reverifyTask(current.task.id)
      }
    })
  }, [newTask, openSettings])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
        setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const openTask = async (id: string, focus?: string) => {
    const next = await window.agent.openTask(id, focus)
    setView(next)
    setFocusId(focus ?? null)
    setSidebarOpen(false)
  }
  const openTaskRef = useRef(openTask)
  openTaskRef.current = openTask

  // Reopen the task that was open when the window last closed.
  useEffect(() => {
    if (!boot || restored.current) return
    restored.current = true
    if (boot.lastTaskId) void openTaskRef.current(boot.lastTaskId).catch(() => undefined)
  }, [boot])

  const loadOlder = async () => {
    const current = view
    if (!current?.hasOlder || !current.cursor) return
    const older = await window.agent.older(current.task.id, current.cursor)
    setView((value) =>
      value && value.task.id === current.task.id
        ? {
            ...value,
            entries: [...older.entries, ...value.entries],
            hasOlder: older.hasOlder,
            cursor: older.cursor,
          }
        : value,
    )
  }

  const submit = async (text: string, tokens: string[], context: ContextRef[] = []) => {
    setFocusId(null)
    if (view) {
      await window.agent.send(view.task.id, text, tokens, context)
    } else {
      const created = await window.agent.createTask(text, tokens, context)
      setView(created)
      void refresh()
    }
  }

  const startLocal = async (model: LocalModel) => {
    await window.agent.saveModel({
      provider: 'compatible',
      modelId: model.modelId,
      baseUrl: model.baseUrl,
      apiKey: 'local',
    })
    await refresh()
  }

  const startDemo = async () => {
    if (auditing) return
    setAuditError(null)
    setAuditing(true)
    try {
      await window.agent.addDemoAccount()
      await refresh()
      setAuditing(false)
      await audit()
    } catch (error) {
      setAuditing(false)
      setAuditError(error instanceof Error ? error.message : String(error))
    }
  }

  const audit = async () => {
    if (auditing) return
    setAuditing(true)
    setAuditProgress(null)
    setAuditError(null)
    try {
      const next = await window.agent.audit()
      setView(next)
      setFocusId(null)
      setSidebarOpen(false)
      void refresh()
    } catch (error) {
      setAuditProgress(null)
      setAuditing(false)
      setAuditError(error instanceof Error ? error.message : String(error))
    }
  }

  const steer = async (text: string) => {
    if (!view) return
    await window.agent.steer(view.task.id, text)
  }

  const stop = () => {
    if (view) void window.agent.stop(view.task.id)
  }

  const rename = async (id: string, title: string) => {
    await window.agent.renameTask(id, title)
  }

  const remove = async (id: string) => {
    await window.agent.deleteTask(id)
    if (view?.task.id === id) setView(null)
    void refresh()
  }

  if (fatal) {
    return <div className="fatal">{t.fatal}</div>
  }

  return (
    <div className="app">
      <div className="dragbar" />
      <Sidebar
        tasks={tasks}
        activeId={view?.task.id ?? null}
        lang={lang}
        open={sidebarOpen}
        onOpen={(id, focus) => void openTask(id, focus)}
        onNew={newTask}
        onSettings={() => openSettings('model')}
        onClose={() => setSidebarOpen(false)}
        onRename={(id, title) => void rename(id, title)}
        onDelete={(id) => void remove(id)}
        onPin={(id, pinned) => void window.agent.pinTask(id, pinned)}
        searchSignal={searchSignal}
      />
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label={t.closeTasks}
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <main className="main">
        <div className="mobile-head">
          <button
            className="icon-btn"
            type="button"
            aria-label={t.showTasks}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={16} />
          </button>
        </div>
        {view ? (
          <Suspense fallback={null}>
            <Run
              key={view.task.id}
              view={view}
              lang={lang}
              focusId={focusId}
              onRetry={() => void window.agent.retryTask(view.task.id)}
              onContinue={() => void window.agent.continueTask(view.task.id)}
              onReverify={() => window.agent.reverifyTask(view.task.id).then(() => undefined)}
              onOlder={loadOlder}
              onAudit={() => void audit()}
              auditing={auditing}
              auditProgress={auditProgress?.taskId === view.task.id ? auditProgress.progress : null}
              staleDays={boot?.settings.staleDays ?? 7}
            />
          </Suspense>
        ) : boot ? (
          <Home
            boot={boot}
            onSetup={() => openSettings('model')}
            onAddAccount={() => openSettings('accounts')}
            onUseLocal={startLocal}
            onDemo={() => void startDemo()}
            onAudit={() => void audit()}
            auditing={auditing}
            tasks={tasks}
            onOpenTask={(id) => void openTask(id)}
          />
        ) : null}
        {auditError && <p className="brief-error audit-error">{auditError}</p>}
        <Composer
          lang={lang}
          modelLabel={boot?.model?.modelId ?? null}
          hasModel={Boolean(boot?.model)}
          live={view?.live ?? null}
          onSend={submit}
          onSteer={steer}
          onStop={stop}
          key={view?.task.id ?? 'new'}
          onOpenSettings={() => openSettings('model')}
          draftKey={view?.task.id ?? 'new'}
        />
      </main>
      {settingsOpen && boot && (
        <Suspense fallback={null}>
          <Settings
            boot={boot}
            initialPane={settingsPane}
            onClose={() => setSettingsOpen(false)}
            onChanged={async () => {
              await refresh()
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
