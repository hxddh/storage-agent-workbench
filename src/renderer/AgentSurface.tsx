import type { BoardItem, InboxItem, Lang, ScheduleItem } from '@shared/contract'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { type Dict, fill } from './i18n'

const Blocks = lazy(() => import('./Blocks').then((module) => ({ default: module.Blocks })))

/**
 * What the agent keeps in front of the user between conversations: what it
 * told them, the views it pinned, and the work it scheduled. All of it is the
 * agent's own output — the window only shows it.
 */
export function AgentSurface({
  t,
  lang,
  onOpenTask,
}: {
  t: Dict
  lang: Lang
  onOpenTask: (id: string) => void
}) {
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [board, setBoard] = useState<BoardItem[]>([])
  const [schedules, setSchedules] = useState<ScheduleItem[]>([])
  const [confirming, setConfirming] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.agent
      .inbox()
      .then(setInbox)
      .catch(() => undefined)
    void window.agent
      .board()
      .then(setBoard)
      .catch(() => undefined)
    void window.agent
      .schedules()
      .then(setSchedules)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    return window.agent.onEvent((event) => {
      if (event.type === 'inbox' || event.type === 'tasks') refresh()
    })
  }, [refresh])

  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : '—'

  const cancel = async (name: string) => {
    if (confirming !== name) {
      setConfirming(name)
      setTimeout(() => setConfirming(null), 3000)
      return
    }
    setConfirming(null)
    await window.agent.cancelSchedule(name)
    refresh()
  }

  if (!inbox.length && !board.length && !schedules.length) return null
  const unread = inbox.filter((item) => !item.read)

  return (
    <div className="agent-surface">
      {inbox.length > 0 && (
        <section className="surface-section" aria-label={t.inbox}>
          <div className="home-recent-head">
            <h2>{t.inbox}</h2>
            {unread.length > 0 && (
              <button
                className="text-action"
                type="button"
                onClick={() => void window.agent.markInboxRead().then(refresh)}
              >
                {t.markAllRead}
              </button>
            )}
          </div>
          <div className="home-recent-list">
            {inbox.slice(0, 8).map((item) => (
              <button
                className={`home-recent-row inbox-row ${item.read ? '' : 'unread'}`}
                type="button"
                key={item.id}
                onClick={() => {
                  void window.agent.markInboxRead(item.id).then(refresh)
                  if (item.taskId) onOpenTask(item.taskId)
                }}
              >
                <span className="inbox-text">
                  <span className="home-recent-title">{item.title}</span>
                  <span className="inbox-body">{item.body}</span>
                </span>
                <span className="home-recent-time">{when(item.createdAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {board.length > 0 && (
        <section className="surface-section" aria-label={t.board}>
          <div className="home-recent-head">
            <h2>{t.board}</h2>
            <span>{board.length}</span>
          </div>
          <div className="board-grid">
            {board.map((item) => (
              <article className="board-card" key={item.path}>
                <header className="board-card-head">
                  <span className="home-recent-title">{item.title}</span>
                  <span className="home-recent-time">{when(item.modifiedAt)}</span>
                </header>
                <Suspense fallback={null}>
                  <Blocks doc={item.doc} t={t} />
                </Suspense>
              </article>
            ))}
          </div>
        </section>
      )}

      {schedules.length > 0 && (
        <section className="surface-section" aria-label={t.scheduled}>
          <div className="home-recent-head">
            <h2>{t.scheduled}</h2>
            <span>{schedules.length}</span>
          </div>
          <div className="home-recent-list">
            {schedules.map((item) => (
              <div className="home-recent-row schedule-row" key={item.name}>
                <button
                  className="schedule-open"
                  type="button"
                  disabled={!item.taskId}
                  onClick={() => item.taskId && onOpenTask(item.taskId)}
                >
                  <span className="home-recent-title">{item.name}</span>
                  <span className="inbox-body">
                    {fill(t.scheduleLine, {
                      cadence: item.cadence,
                      next: when(item.nextAt),
                      budget: item.budgetTokens.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en'),
                    })}
                  </span>
                </button>
                <button
                  className="text-action"
                  type="button"
                  onClick={() => void cancel(item.name)}
                >
                  {confirming === item.name ? `${t.cancelSchedule}?` : t.cancelSchedule}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
