import type { AppEvent, Bootstrap, TaskSummary, TaskView } from '@shared/contract'
import { Menu } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Composer } from './Composer'
import { dict } from './i18n'
import { Settings } from './Settings'
import { Sidebar } from './Sidebar'
import { Stream } from './Stream'

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
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [fatal, setFatal] = useState(false)

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

  const newTask = useCallback(() => {
    setView(null)
    setSidebarOpen(false)
  }, [])

  useEffect(() => {
    if (!('agent' in window)) return
    return window.agent.onCommand((command) => {
      if (command === 'settings') setSettingsOpen(true)
      if (command === 'new-task') newTask()
    })
  }, [newTask])

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

  const openTask = async (id: string) => {
    const next = await window.agent.openTask(id)
    setView(next)
    setSidebarOpen(false)
  }

  const submit = async (text: string, tokens: string[]) => {
    if (view) {
      await window.agent.send(view.task.id, text, tokens)
    } else {
      const created = await window.agent.createTask(text, tokens)
      setView(created)
      void refresh()
    }
  }

  const steer = async (text: string) => {
    if (!view) return
    await window.agent.steer(view.task.id, text)
  }

  const stop = () => {
    if (view) void window.agent.stop(view.task.id)
  }

  const older = async () => {
    if (!view?.cursor) return
    const page = await window.agent.older(view.task.id, view.cursor)
    setView({
      ...view,
      entries: [...page.entries, ...view.entries],
      hasOlder: page.hasOlder,
      cursor: page.cursor,
    })
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

  const hasModel = Boolean(boot?.model)
  const hasAccount = (boot?.accounts.length ?? 0) > 0

  return (
    <div className="app">
      <div className="dragbar" />
      <Sidebar
        tasks={tasks}
        activeId={view?.task.id ?? null}
        lang={lang}
        open={sidebarOpen}
        onOpen={(id) => void openTask(id)}
        onNew={newTask}
        onSettings={() => setSettingsOpen(true)}
        onRename={(id, title) => void rename(id, title)}
        onDelete={(id) => void remove(id)}
      />
      <main className="main">
        {view ? (
          <>
            <div className="main-head">
              <button
                className="icon-btn only-mobile"
                type="button"
                aria-label={t.showTasks}
                onClick={() => setSidebarOpen(true)}
              >
                <Menu size={16} />
              </button>
              <span className="task-title">{view.task.title}</span>
              <span />
            </div>
            <Stream view={view} lang={lang} onOlder={() => void older()} />
          </>
        ) : (
          <div className="empty">
            <h1>{t.emptyTitle}</h1>
            <p>{!hasModel ? t.emptyNoModel : !hasAccount ? t.emptyNoAccount : t.emptyHint}</p>
            {(!hasModel || !hasAccount) && (
              <div className="setup">
                <button className="btn" type="button" onClick={() => setSettingsOpen(true)}>
                  {!hasModel ? t.setModel : t.addAccount}
                </button>
              </div>
            )}
          </div>
        )}
        <Composer
          lang={lang}
          modelLabel={boot?.model?.modelId ?? null}
          hasModel={hasModel}
          live={view?.live ?? null}
          onSend={submit}
          onSteer={steer}
          onStop={stop}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </main>
      {settingsOpen && boot && (
        <Settings
          boot={boot}
          onClose={() => setSettingsOpen(false)}
          onChanged={async () => {
            await refresh()
          }}
        />
      )}
    </div>
  )
}
