import type { TaskView, ToolName, ToolStatus, ToolView, UiEntry } from '@shared/contract'
import {
  Activity,
  Archive,
  BarChart3,
  ChevronRight,
  Copy,
  Database,
  Download,
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
import { copyText, safeFileName } from './lib/export'
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

function duration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}

function useElapsed(startedAt: string | null): number | null {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!startedAt) return
    const timer = setInterval(() => tick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  if (!startedAt) return null
  const started = Date.parse(startedAt)
  return Number.isNaN(started) ? null : Date.now() - started
}

function ToolLine({
  name,
  target,
  note,
  status,
  ms,
  startedAt,
  view,
  entryId,
  lang,
  taskTitle,
}: {
  name: ToolName
  target: string
  note: string | null
  status: ToolStatus
  ms: number | null
  startedAt?: string | null
  view: ToolView | null
  entryId: string
  lang: 'en' | 'zh'
  taskTitle: string
}) {
  const [open, setOpen] = useState(false)
  const t = dict(lang)
  const Icon = ICONS[name] ?? Activity
  const running = status === 'running'
  const elapsed = useElapsed(running ? (startedAt ?? null) : null)
  const shown = running ? elapsed : ms
  const expandable = !running && Boolean(view)

  return (
    <div className={`tool ${open ? 'open' : ''} ${status}`} data-entry-id={entryId}>
      <button
        className="tool-row"
        type="button"
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen((value) => !value)}
      >
        <Icon className={`tool-icon ${running ? 'pulse-icon' : ''}`} size={14} strokeWidth={1.6} />
        <span className="verb">{toolLabel(name, lang)}</span>
        {target && <span className="target">{target}</span>}
        {(note || status === 'stopped') && <span className="note">{note ?? t.stopped}</span>}
        {shown !== null && <span className="time">{duration(shown)}</span>}
        {expandable && <ChevronRight size={13} className="chev" />}
      </button>
      {open && view && (
        <div className="tool-body">
          <ToolViewBody view={view} t={t} taskTitle={taskTitle} />
        </div>
      )}
    </div>
  )
}

function AnswerBlock({
  text,
  lang,
  taskTitle,
  entryId,
  streaming,
}: {
  text: string
  lang: 'en' | 'zh'
  taskTitle: string
  entryId: string
  streaming?: boolean
}) {
  const t = dict(lang)
  const [copied, setCopied] = useState(false)

  return (
    <div className="entry entry-answer" data-entry-id={entryId}>
      <div className={`prose ${streaming ? 'streaming' : ''}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
      {!streaming && (
        <div className="answer-actions">
          <button
            className="text-action"
            type="button"
            onClick={async () => {
              if (await copyText(text)) {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }
            }}
          >
            <Copy size={12} />
            {copied ? t.copied : t.copy}
          </button>
          <button
            className="text-action"
            type="button"
            onClick={() =>
              void window.agent.saveText({
                name: safeFileName(taskTitle, 'md'),
                content: text,
                kind: 'markdown',
              })
            }
          >
            <Download size={12} />
            {t.saveAs}
          </button>
        </div>
      )}
    </div>
  )
}

export function Stream({
  view,
  lang,
  focusId,
  onOlder,
  onRetry,
  onContinue,
}: {
  view: TaskView
  lang: 'en' | 'zh'
  focusId: string | null
  onOlder: () => void
  onRetry: () => void
  onContinue: () => void
}) {
  const t = dict(lang)
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const focused = useRef<string | null>(null)

  const committed = new Set(
    view.entries
      .filter((entry): entry is Extract<UiEntry, { kind: 'tool' }> => entry.kind === 'tool')
      .map((entry) => entry.callId)
      .filter((callId): callId is string => Boolean(callId)),
  )
  const running = (view.live?.tools ?? []).filter((tool) => !committed.has(tool.callId))

  useEffect(() => {
    const element = ref.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  })

  useEffect(() => {
    if (!focusId || focused.current === focusId) return
    focused.current = focusId
    const element = ref.current?.querySelector<HTMLElement>(
      `[data-entry-id="${CSS.escape(focusId)}"]`,
    )
    if (!element) return
    element.scrollIntoView({ block: 'center' })
    element.classList.add('flash')
    const timer = setTimeout(() => element.classList.remove('flash'), 1600)
    return () => clearTimeout(timer)
  }, [focusId])

  const onScroll = () => {
    const element = ref.current
    if (!element) return
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90
  }

  return (
    <div className="scroll" ref={ref} onScroll={onScroll}>
      <div className="stream">
        {view.hasOlder && (
          <button className="text-action older" type="button" onClick={onOlder}>
            {t.older}
          </button>
        )}
        {view.entries.map((entry, index) => {
          if (entry.kind === 'user') {
            return (
              <div className="entry entry-user" key={entry.id} data-entry-id={entry.id}>
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
              <AnswerBlock
                key={entry.id}
                entryId={entry.id}
                text={entry.text}
                lang={lang}
                taskTitle={view.task.title}
              />
            )
          }
          if (entry.kind === 'tool') {
            return (
              <ToolLine
                key={entry.id}
                entryId={entry.id}
                name={entry.name}
                target={entry.target}
                note={entry.note}
                status={entry.status}
                ms={entry.ms}
                view={entry.view}
                lang={lang}
                taskTitle={view.task.title}
              />
            )
          }
          if (entry.kind === 'notice') {
            const actionable =
              Boolean(entry.action) &&
              !view.entries.slice(index + 1).some((later) => later.kind === 'user')
            return (
              <div
                className={`entry entry-notice ${entry.tone}`}
                key={entry.id}
                data-entry-id={entry.id}
              >
                <span className="dot" />
                <span className="text">{entry.text}</span>
                {actionable && (
                  <button
                    className="text-action"
                    type="button"
                    onClick={entry.action === 'retry' ? onRetry : onContinue}
                  >
                    {entry.action === 'retry' ? t.retry : t.continue}
                  </button>
                )}
              </div>
            )
          }
          return (
            <div className="entry-compaction" key={entry.id}>
              {entry.text}
            </div>
          )
        })}

        {running.map((tool) => (
          <ToolLine
            key={tool.callId}
            entryId={`live:${tool.callId}`}
            name={tool.name}
            target={tool.target}
            note={tool.note}
            status="running"
            ms={null}
            startedAt={tool.startedAt}
            view={null}
            lang={lang}
            taskTitle={view.task.title}
          />
        ))}

        {view.live && !view.live.text && running.length === 0 && (
          <div className="live-row">
            <span className="pulse" />
            {t.thinking}…
          </div>
        )}

        {view.live?.text && (
          <AnswerBlock
            entryId="streaming"
            text={view.live.text}
            lang={lang}
            taskTitle={view.task.title}
            streaming
          />
        )}
      </div>
    </div>
  )
}
