import type { SearchHit, TaskSummary } from '@shared/contract'
import { MoreHorizontal, Plus, Search, Settings2, Shield, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { dict } from './i18n'

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

function TaskRow({
  task,
  active,
  lang,
  onOpen,
  onRename,
  onDelete,
}: {
  task: TaskSummary
  active: boolean
  lang: 'en' | 'zh'
  onOpen: () => void
  onRename: (title: string) => void
  onDelete: () => void
}) {
  const t = dict(lang)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(task.title)
  const [menu, setMenu] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])

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
        >
          {task.state !== 'ready' && <span className={`dot ${task.state}`} />}
          {task.origin === 'watch' && <Shield size={11} className="watch" />}
          <span className="title">{task.title}</span>
        </button>
      )}
      <button
        className="icon-btn row-more"
        type="button"
        aria-label="More"
        onClick={(event) => {
          event.stopPropagation()
          setConfirming(false)
          setMenu((open) => !open)
        }}
      >
        <MoreHorizontal size={14} />
      </button>
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
}: {
  tasks: TaskSummary[]
  activeId: string | null
  lang: 'en' | 'zh'
  open: boolean
  onOpen: (id: string, focus?: string) => void
  onNew: () => void
  onSettings: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
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

  const choose = (hit: SearchHit) => {
    onOpen(hit.taskId, hit.entryId ?? undefined)
    setQuery('')
    input.current?.blur()
  }

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="brand">
        <span className="mark" />
        Storage Agent
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
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              active={task.id === activeId}
              lang={lang}
              onOpen={() => onOpen(task.id)}
              onRename={(title) => onRename(task.id, title)}
              onDelete={() => onDelete(task.id)}
            />
          ))
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
