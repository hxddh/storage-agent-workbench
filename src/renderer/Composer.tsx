import type { ContextRef, Live, StagedFile, StorageRef } from '@shared/contract'
import { ArrowUp, AtSign, ChevronDown, Paperclip, Square, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { dict, fill, toolLabel } from './i18n'

export function Composer({
  lang,
  hasModel,
  modelLabel,
  live,
  onSend,
  onSteer,
  onStop,
  onOpenSettings,
  draftKey,
}: {
  lang: 'en' | 'zh'
  hasModel: boolean
  modelLabel: string | null
  live: Live | null
  onSend: (text: string, tokens: string[], context: ContextRef[]) => Promise<void>
  onSteer: (text: string, tokens: string[], context: ContextRef[]) => Promise<void>
  onStop: () => void
  onOpenSettings: () => void
  draftKey: string
}) {
  const t = dict(lang)
  const [text, setText] = useState(() => window.localStorage.getItem(`sa.draft:${draftKey}`) ?? '')
  const [files, setFiles] = useState<StagedFile[]>([])
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [context, setContext] = useState<ContextRef[]>([])
  const [refs, setRefs] = useState<StorageRef[]>([])
  const [picker, setPicker] = useState<string | null>(null)
  const [pickIndex, setPickIndex] = useState(0)
  const [now, setNow] = useState(Date.now())
  const ref = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const key = `sa.draft:${draftKey}`
    if (text) window.localStorage.setItem(key, text)
    else window.localStorage.removeItem(key)
  }, [text, draftKey])

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
    if (picker === null) return
    setPickIndex(0)
    let live = true
    void window.agent
      .storageRefs(picker)
      .then((rows) => {
        if (live) setRefs(rows)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [picker])

  useEffect(() => {
    if (picker === null) return
    const close = (event: PointerEvent) => {
      if (composerRef.current?.contains(event.target as Node)) return
      setPicker(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [picker])

  const pick = (item: StorageRef) => {
    setContext((current) =>
      current.some((ref) => ref.providerId === item.providerId && ref.label === item.label)
        ? current
        : [
            ...current,
            {
              kind: item.kind,
              providerId: item.providerId,
              label: item.label,
              ...(item.bucket ? { bucket: item.bucket } : {}),
            },
          ],
    )
    setText((value) => value.replace(/@[^@\s]*$/, '').trimEnd())
    setPicker(null)
    ref.current?.focus()
  }

  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  })

  const send = async () => {
    const value = text.trim()
    if (!hasModel || busy) return
    if (live) {
      // A steer joins the running turn: its files and @refs go with it, not
      // into a later question.
      if (!value && files.length === 0) return
      setBusy(true)
      try {
        await onSteer(
          value,
          files.map((file) => file.token),
          context,
        )
        setText('')
        setFiles([])
        setContext([])
      } finally {
        setBusy(false)
      }
      return
    }
    if (!value && files.length === 0) return
    setBusy(true)
    // Clear the persisted draft before creating the task. The composer is
    // keyed by task id and unmounts immediately after onSend, so clearing it
    // after the await would leave the sent question in the next task's draft.
    const key = `sa.draft:${draftKey}`
    window.localStorage.removeItem(key)
    setText('')
    try {
      await onSend(
        value,
        files.map((file) => file.token),
        context,
      )
      setFiles([])
      setContext([])
    } catch {
      // Restore both the field and its draft now: a failure can be followed
      // by a task switch before the effect that persists text runs.
      setText(value)
      window.localStorage.setItem(key, value)
    } finally {
      setBusy(false)
    }
  }

  const attach = async () => {
    const picked = await window.agent.pickFiles()
    if (picked.length) setFiles((current) => [...current, ...picked].slice(0, 10))
  }

  const active = live?.tools.filter((tool) => tool.status === 'running').at(-1)
  const lastTool = live?.tools.at(-1)
  const failed = lastTool?.status === 'failed' ? lastTool : undefined
  const elapsed = live
    ? Math.max(0, Math.floor((now - (Date.parse(live.startedAt) || now)) / 1000))
    : 0
  const elapsedLabel =
    elapsed < 1
      ? '<1s'
      : elapsed < 60
        ? fill(t.liveSeconds, { n: elapsed })
        : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  const phase =
    live?.phase === 'tool'
      ? active?.target
        ? `${t.liveReading} ${active.target}`
        : t.livePacing
      : live?.phase === 'writing'
        ? t.writing
        : live?.phase === 'reasoning'
          ? t.thinking
          : t.thinking
  const failedLabel =
    !active && failed ? `${toolLabel(failed.name, lang)}: ${t.runWorkFailed}` : null

  return (
    <div className="composer-dock">
      {live && (
        <div className="run-strip">
          <span className="run-dot" aria-hidden="true" />
          <span className="run-phase" role="status">
            {failedLabel ?? phase}
          </span>
          {active?.note && <span className="run-note">{active.note}</span>}
          <span className="run-elapsed" aria-hidden="true">
            {elapsedLabel}
          </span>
        </div>
      )}
      <div
        className={`composer ${focused ? 'focused' : ''} ${dragging ? 'dragging' : ''}`}
        ref={composerRef}
      >
        {dragging && <div className="drop-hint">{t.dropHint}</div>}
        {(files.length > 0 || context.length > 0) && (
          <div className="attachments">
            {context.map((item) => (
              <span className="attachment context-chip" key={`${item.providerId}:${item.label}`}>
                <AtSign size={10} aria-hidden="true" />
                {item.label}
                <button
                  type="button"
                  aria-label={t.remove}
                  onClick={() =>
                    setContext((current) =>
                      current.filter(
                        (ref) => !(ref.providerId === item.providerId && ref.label === item.label),
                      ),
                    )
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ))}
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
          placeholder={hasModel ? t.placeholder : t.emptyNoModel}
          rows={1}
          disabled={!hasModel}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            const value = event.target.value
            setText(value)
            const match = /@([^@\s]*)$/.exec(value)
            setPicker(match ? (match[1] ?? '') : null)
          }}
          onPaste={(event) => {
            if (event.clipboardData.files.length === 0) return
            event.preventDefault()
            void stage(event.clipboardData.files)
          }}
          onKeyDown={(event) => {
            if (picker !== null && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              if (!refs.length) return
              setPickIndex((index) =>
                event.key === 'ArrowDown'
                  ? Math.min(refs.length - 1, index + 1)
                  : Math.max(0, index - 1),
              )
              return
            }
            if (event.key === 'Escape' && picker !== null) {
              event.preventDefault()
              setPicker(null)
              return
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (picker !== null && refs[pickIndex]) {
                pick(refs[pickIndex]!)
                return
              }
              void send()
            }
          }}
        />
        {picker !== null && (
          <div className="ref-picker" role="listbox" aria-label={t.attachContext}>
            {refs.length === 0 ? (
              <p className="ref-empty">{t.noRefs}</p>
            ) : (
              refs.map((item, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === pickIndex}
                  className={`ref-row ${index === pickIndex ? 'active' : ''}`}
                  key={item.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setPickIndex(index)}
                  onClick={() => pick(item)}
                >
                  <span className={`ref-kind ${item.kind}`}>{item.kind}</span>
                  <span className="ref-label">{item.label}</span>
                  <span className="ref-detail">{item.detail}</span>
                </button>
              ))
            )}
          </div>
        )}
        <div className="composer-foot">
          <button
            className="icon-btn"
            type="button"
            aria-label={t.attach}
            disabled={!hasModel}
            onClick={() => void attach()}
          >
            <Paperclip size={15} strokeWidth={1.7} />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label={t.attachContext}
            title={t.attachContext}
            disabled={!hasModel}
            onClick={() => {
              setPicker('')
              ref.current?.focus()
            }}
          >
            <AtSign size={15} strokeWidth={1.7} />
          </button>
          {hasModel && (
            <button className="model-chip" type="button" onClick={onOpenSettings}>
              <span>{modelLabel ?? t.model}</span>
              <ChevronDown size={11} />
            </button>
          )}
          <span className="spacer" />
          {live ? (
            <>
              <button
                className="send steer"
                type="button"
                aria-label={t.steer}
                title={t.steer}
                disabled={!text.trim() && files.length === 0}
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
              disabled={!hasModel || busy || (!text.trim() && files.length === 0)}
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
