import type { Live, StagedFile } from '@shared/contract'
import { ArrowUp, ChevronDown, Paperclip, Square, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { dict } from './i18n'

export function Composer({
  lang,
  hasModel,
  modelLabel,
  live,
  onSend,
  onSteer,
  onStop,
  onOpenSettings,
}: {
  lang: 'en' | 'zh'
  hasModel: boolean
  modelLabel: string | null
  live: Live | null
  onSend: (text: string, tokens: string[]) => Promise<void>
  onSteer: (text: string) => Promise<void>
  onStop: () => void
  onOpenSettings: () => void
}) {
  const t = dict(lang)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<StagedFile[]>([])
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  const stage = useCallback(async (list: FileList | File[]) => {
    const picked = await window.agent.stageFiles([...list])
    if (picked.length) setFiles((current) => [...current, ...picked].slice(0, 10))
  }, [])

  // The whole window is a drop target; the composer shows where the file goes.
  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'))
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth += 1
      setDragging(true)
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      if (event.dataTransfer?.files.length) void stage(event.dataTransfer.files)
      ref.current?.focus()
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [stage])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  })

  const send = async () => {
    const value = text.trim()
    if (busy || (!value && files.length === 0)) return
    setBusy(true)
    try {
      if (live) {
        await onSteer(value)
      } else {
        await onSend(
          value,
          files.map((file) => file.token),
        )
      }
      setText('')
      setFiles([])
    } finally {
      setBusy(false)
    }
  }

  const attach = async () => {
    const picked = await window.agent.pickFiles()
    if (picked.length) setFiles((current) => [...current, ...picked].slice(0, 10))
  }

  return (
    <div className="composer-dock">
      <div className={`composer ${focused ? 'focused' : ''} ${dragging ? 'dragging' : ''}`}>
        {dragging && <div className="drop-hint">{t.dropHint}</div>}
        {files.length > 0 && (
          <div className="attachments">
            {files.map((file) => (
              <span className="attachment" key={file.token}>
                {file.name}
                <button
                  type="button"
                  aria-label={t.remove}
                  onClick={() =>
                    setFiles((current) => current.filter((item) => item.token !== file.token))
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          placeholder={t.placeholder}
          rows={1}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            if (event.clipboardData.files.length === 0) return
            event.preventDefault()
            void stage(event.clipboardData.files)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="composer-foot">
          <button
            className="icon-btn"
            type="button"
            aria-label={t.attach}
            onClick={() => void attach()}
          >
            <Paperclip size={15} strokeWidth={1.7} />
          </button>
          <button className="model-chip" type="button" onClick={onOpenSettings}>
            <span>{hasModel ? (modelLabel ?? 'Model') : 'Model'}</span>
            <ChevronDown size={11} />
          </button>
          <span className="spacer" />
          {live ? (
            <>
              <button
                className="send steer"
                type="button"
                aria-label={t.steer}
                title={t.steer}
                disabled={!text.trim()}
                onClick={() => void send()}
              >
                <ArrowUp size={15} strokeWidth={2} />
              </button>
              <button
                className="send stop"
                type="button"
                aria-label={t.stop}
                title={t.stop}
                onClick={onStop}
              >
                <Square size={12} fill="currentColor" />
              </button>
            </>
          ) : (
            <button
              className="send"
              type="button"
              aria-label={t.send}
              disabled={busy || (!text.trim() && files.length === 0)}
              onClick={() => void send()}
            >
              <ArrowUp size={15} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
