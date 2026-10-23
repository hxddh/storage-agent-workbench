import type { TaskSummary } from '@shared/contract'
import { MoreHorizontal, Plus, Settings2, Shield } from 'lucide-react'
import { useState } from 'react'
import { dict } from './i18n'

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

  return (
    <div className="task-row-wrap" style={{ position: 'relative' }}>
      {editing ? (
        <input
          autoFocus
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
          style={{
            width: '100%',
            height: 30,
            border: '1px solid var(--accent)',
            borderRadius: 'var(--r-s)',
            background: 'var(--surface)',
            padding: '0 8px',
            fontSize: 13,
            outline: 'none',
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
        style={{ position: 'absolute', right: 2, top: 3, width: 24, height: 24 }}
        type="button"
        aria-label="More"
        onClick={(event) => {
          event.stopPropagation()
          setMenu((value) => !value)
        }}
      >
        <MoreHorizontal size={14} />
      </button>
      {menu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 25 }}
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
                setMenu(false)
                if (window.confirm(t.confirmDelete)) onDelete()
              }}
            >
              {t.delete}
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
  onOpen: (id: string) => void
  onNew: () => void
  onSettings: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}) {
  const t = dict(lang)
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="brand">
        <span className="mark" />
        Storage Agent
      </div>
      <button className="new-task" type="button" onClick={onNew}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Plus size={14} strokeWidth={1.8} />
          {t.newTask}
        </span>
        <kbd>⌘N</kbd>
      </button>
      <div className="task-list">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            active={task.id === activeId}
            lang={lang}
            onOpen={() => onOpen(task.id)}
            onRename={(title) => onRename(task.id, title)}
            onDelete={() => onDelete(task.id)}
          />
        ))}
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
