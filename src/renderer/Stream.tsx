import type { TaskView, ToolName, UiEntry } from '@shared/contract'
import {
  Activity,
  Archive,
  BarChart3,
  ChevronRight,
  Database,
  FileText,
  List,
  Radar,
  Shield,
  StickyNote,
  Wrench,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { dict, toolLabel } from './i18n'
import { ToolViewBody } from './Views'

const ICONS: Record<ToolName, typeof Radar> = {
  survey: Radar,
  buckets: Database,
  objects: List,
  object: FileText,
  config: Shield,
  probe: Activity,
  estate: Archive,
  fix: Wrench,
  analyze: BarChart3,
  note: StickyNote,
}

function ToolRow({
  entry,
  lang,
}: {
  entry: Extract<UiEntry, { kind: 'tool' }>
  lang: 'en' | 'zh'
}) {
  const [open, setOpen] = useState(false)
  const t = dict(lang)
  const Icon = ICONS[entry.name] ?? Activity
  return (
    <div className={`tool ${open ? 'open' : ''} ${entry.status}`}>
      <button
        className="tool-row"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon className="tool-icon" size={14} strokeWidth={1.6} />
        <span className="verb">{toolLabel(entry.name, lang)}</span>
        {entry.target && <span className="target">{entry.target}</span>}
        {entry.note && <span className="note">{entry.note}</span>}
        {entry.ms !== null && <span className="time">{(entry.ms / 1000).toFixed(1)}s</span>}
        <ChevronRight size={13} className="chev" />
      </button>
      {open && (
        <div className="tool-body">
          {entry.view ? (
            <ToolViewBody view={entry.view} t={t} />
          ) : (
            <p className="impact-note">
              {entry.status === 'failed' ? t.failed : (entry.note ?? t.emptyStream)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function Stream({
  view,
  lang,
  onOlder,
}: {
  view: TaskView
  lang: 'en' | 'zh'
  onOlder: () => void
}) {
  const t = dict(lang)
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const lastEntry = view.entries.at(-1)

  useEffect(() => {
    const element = ref.current
    if (element && stick.current) {
      element.scrollTop = element.scrollHeight
    }
  })

  const onScroll = () => {
    const element = ref.current
    if (!element) return
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90
  }

  return (
    <div className="scroll" ref={ref} onScroll={onScroll}>
      <div className="stream">
        {view.hasOlder && (
          <button
            className="btn ghost"
            type="button"
            style={{ alignSelf: 'center' }}
            onClick={onOlder}
          >
            {t.older}
          </button>
        )}
        {view.entries.map((entry) => {
          if (entry.kind === 'user') {
            return (
              <div className="entry entry-user" key={entry.id}>
                <div className="label">{t.you}</div>
                <div className="text">{entry.text}</div>
                {entry.attachments.length > 0 && (
                  <div className="files">
                    {entry.attachments.map((file) => (
                      <span className="file-chip" key={file.name}>
                        <FileText size={11} />
                        {file.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          }
          if (entry.kind === 'answer') {
            return (
              <div className="entry entry-answer" key={entry.id}>
                <div className="prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
                </div>
              </div>
            )
          }
          if (entry.kind === 'tool') {
            return <ToolRow entry={entry} lang={lang} key={entry.id} />
          }
          if (entry.kind === 'notice') {
            return (
              <div className={`entry entry-notice ${entry.tone}`} key={entry.id}>
                <span className="dot" />
                <span className="text">{entry.text}</span>
              </div>
            )
          }
          return (
            <div className="entry-compaction" key={entry.id}>
              {entry.text}
            </div>
          )
        })}
        {view.live && view.live.phase === 'writing' && view.live.text && (
          <div className="entry entry-answer">
            <div className="prose streaming">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.live.text}</ReactMarkdown>
            </div>
          </div>
        )}
        {view.live && view.live.phase !== 'writing' && (
          <div className="live-row">
            <span className="pulse" />
            {view.live.phase === 'tool' && view.live.tool ? (
              <>
                {toolLabel(view.live.tool.name, lang)}
                {view.live.tool.target && <span className="target">{view.live.tool.target}</span>}
              </>
            ) : (
              <>{t.thinking}…</>
            )}
          </div>
        )}
        {!view.live && lastEntry?.kind === 'tool' && lastEntry.status === 'running' && (
          <div className="live-row">
            <span className="pulse" />
            {t.working}…
          </div>
        )}
      </div>
    </div>
  )
}
