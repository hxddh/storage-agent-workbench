import type { SearchHit, TaskSummary } from '@shared/contract'
import { MoreHorizontal, Pin, PinOff, Plus, Search, Settings2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dict } from './i18n'
import { LogoMark } from './Logo'

function Snippet({ text, query }: { text: string; query: string }) {
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  )
}

function relative(iso: string, lang: 'en' | 'zh'): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (lang === 'zh') {
    if (seconds < 60) return '刚刚'
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分`
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 时`
    return `${Math.floor(seconds / 86_400)} 天`
  }
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

function TaskRow({
  task,
  active,
  lang,
  onOpen,
  onRename,
  onDelete,
  onPin,
}: {
  task: TaskSummary
  active: boolean
  lang: 'en' | 'zh'
  onOpen: () => void
  onRename: (title: string) => void
  onDelete: () => void
  onPin: () => void
}) {
  const t = dict(lang)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(task.title)
  const [menu, setMenu] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const tipTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])

  useEffect(() => {
    return () => {
      if (tipTimer.current !== null) window.clearTimeout(tipTimer.current)
    }
  }, [])

  const hideTip = () => {
    if (tipTimer.current !== null) window.clearTimeout(tipTimer.current)
    tipTimer.current = null
    setTip(null)
  }

  const showTip = () => {
    if (tipTimer.current !== null) return
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = null
      const element = titleRef.current
      if (!element || element.scrollWidth <= element.clientWidth + 1) return
      const rect = element.getBoundingClientRect()
      const above = rect.bottom + 40 > window.innerHeight
      setTip({
        left: Math.max(8, rect.left),
        top: above ? rect.top - 32 : rect.bottom + 6,
      })
    }, 480)
  }

  return (
    <div className="task-row-wrap">
      {editing ? (
        <input
          autoFocus
          className="rename-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            setEditing(false)
            if (value.trim() && value !== task.title) onRename(value.trim())
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setEditing(false)
              if (value.trim() && value !== task.title) onRename(value.trim())
            }
            if (event.key === 'Escape') {
              setValue(task.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          className={`task-row ${active ? 'active' : ''}`}
          onClick={onOpen}
          onDoubleClick={() => {
            setValue(task.title)
            setEditing(true)
          }}
          type="button"
          aria-current={active ? 'page' : undefined}
          onPointerEnter={showTip}
          onPointerLeave={hideTip}
          onFocus={showTip}
          onBlur={hideTip}
        >
          {task.state !== 'ready' && <span className={`dot ${task.state}`} aria-hidden="true" />}
          <span className="title" ref={titleRef}>
            {task.title}
          </span>
          {task.pinned && <Pin size={10} className="pin-mark" aria-hidden="true" />}
          <span className="task-time">{relative(task.updatedAt, lang)}</span>
        </button>
      )}
      <button
        className="icon-btn row-more"
        type="button"
        aria-label={t.taskActions}
        onClick={(event) => {
          event.stopPropagation()
          setConfirming(false)
          setMenu((open) => !open)
        }}
      >
        <MoreHorizontal size={14} />
      </button>
      {tip &&
        !menu &&
        !editing &&
        createPortal(
          <div className="row-tip" style={{ left: tip.left, top: tip.top }} role="tooltip">
            {task.title}
          </div>,
          document.body,
        )}
      {menu && (
        <>
          <div
            className="menu-scrim"
            onClick={() => setMenu(false)}
            onKeyDown={() => setMenu(false)}
          />
          <div className="menu" style={{ right: 0, top: 30 }}>
            <button
              type="button"
              onClick={() => {
                setMenu(false)
                setValue(task.title)
                setEditing(true)
              }}
            >
              {t.rename}
            </button>
            <button
              type="button"
              onClick={() => {
                setMenu(false)
                onPin()
              }}
            >
              {task.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              {task.pinned ? t.unpin : t.pin}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!confirming) {
                  setConfirming(true)
                  return
                }
                setMenu(false)
                setConfirming(false)
                onDelete()
              }}
            >
              {confirming ? `${t.delete}?` : t.delete}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function Sidebar({
  tasks,
  activeId,
  lang,
  open,
  onOpen,
  onNew,
  onSettings,
  onRename,
  onDelete,
  onPin,
  searchSignal = 0,
}: {
  searchSignal?: number
  tasks: TaskSummary[]
  activeId: string | null
  lang: 'en' | 'zh'
  open: boolean
  onOpen: (id: string, focus?: string) => void
  onNew: () => void
  onSettings: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
}) {
  const t = dict(lang)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ⌘K from the application menu.
  useEffect(() => {
    if (!searchSignal) return
    input.current?.focus()
    input.current?.select()
  }, [searchSignal])

  useEffect(() => {
    const value = query.trim()
    if (!value) {
      setHits([])
      setSelected(0)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void window.agent.search(value).then((result) => {
        if (!live) return
        setHits(result)
        setSelected(0)
      })
    }, 120)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  const clear = () => {
    setQuery('')
    input.current?.blur()
  }

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const grouped = {
    pinned: tasks.filter((task) => task.pinned),
    today: tasks.filter(
      (task) => !task.pinned && Date.parse(task.updatedAt) >= startOfToday.getTime(),
    ),
    earlier: tasks.filter(
      (task) => !task.pinned && Date.parse(task.updatedAt) < startOfToday.getTime(),
    ),
  }

  const choose = (hit: SearchHit) => {
    onOpen(hit.taskId, hit.entryId ?? undefined)
    setQuery('')
    input.current?.blur()
  }

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="brand">
        <LogoMark size={24} />
        <span className="brand-name">Storage Agent</span>
      </div>
      <button className="new-task" type="button" onClick={onNew}>
        <span className="new-task-label">
          <Plus size={14} strokeWidth={1.8} />
          {t.newTask}
        </span>
        <kbd>⌘N</kbd>
      </button>

      <div className="sidebar-search">
        <Search size={13} strokeWidth={1.8} />
        <input
          ref={input}
          value={query}
          placeholder={t.searchPlaceholder}
          aria-label={t.search}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              clear()
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelected((index) => Math.min(index + 1, hits.length - 1))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelected((index) => Math.max(index - 1, 0))
            }
            if (event.key === 'Enter' && hits[selected]) {
              event.preventDefault()
              choose(hits[selected]!)
            }
          }}
        />
        {query ? (
          <button type="button" aria-label={t.clear} onClick={clear}>
            <X size={12} />
          </button>
        ) : (
          <kbd>⌘K</kbd>
        )}
      </div>

      <div className="task-list">
        {query.trim() ? (
          hits.length === 0 ? (
            <p className="search-empty">{t.noMatches}</p>
          ) : (
            hits.map((hit, index) => (
              <button
                key={hit.taskId + (hit.entryId ?? 'title')}
                type="button"
                className={`search-hit ${index === selected ? 'active' : ''}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(hit)}
              >
                <span className="hit-title">{hit.title}</span>
                <span className="hit-snippet">
                  <Snippet text={hit.snippet} query={query.trim()} />
                </span>
              </button>
            ))
          )
        ) : (
          <>
            {grouped.pinned.length > 0 && (
              <>
                <p className="task-group">{t.pinned}</p>
                {grouped.pinned.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    active={task.id === activeId}
                    lang={lang}
                    onOpen={() => onOpen(task.id)}
                    onRename={(title) => onRename(task.id, title)}
                    onDelete={() => onDelete(task.id)}
                    onPin={() => onPin(task.id, !task.pinned)}
                  />
                ))}
              </>
            )}
            {grouped.today.length > 0 && (
              <>
                <p className="task-group">{t.today}</p>
                {grouped.today.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    active={task.id === activeId}
                    lang={lang}
                    onOpen={() => onOpen(task.id)}
                    onRename={(title) => onRename(task.id, title)}
                    onDelete={() => onDelete(task.id)}
                    onPin={() => onPin(task.id, !task.pinned)}
                  />
                ))}
              </>
            )}
            {grouped.earlier.length > 0 && (
              <>
                <p className="task-group">{t.earlier}</p>
                {grouped.earlier.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    active={task.id === activeId}
                    lang={lang}
                    onOpen={() => onOpen(task.id)}
                    onRename={(title) => onRename(task.id, title)}
                    onDelete={() => onDelete(task.id)}
                    onPin={() => onPin(task.id, !task.pinned)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
      <div className="sidebar-foot">
        <button className="side-link" type="button" onClick={onSettings}>
          <Settings2 size={14} strokeWidth={1.7} />
          {t.settings}
        </button>
      </div>
    </aside>
  )
}
