import {
  type Lang,
  type LocalModel,
  TASK_LINK_PREFIX,
  type TaskModel,
  type TaskView,
  type ToolStatus,
} from '@shared/contract'
import {
  callFor,
  latestPlans,
  pendingQuestion,
  type ThreadItem,
  thread,
  transcriptMarkdown,
} from '@shared/conversation'
import {
  Check,
  ChevronRight,
  Circle,
  Copy,
  LoaderCircle,
  MoreHorizontal,
  Paperclip,
  TriangleAlert,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Dict, dict, fill, toolLabel } from './i18n'
import { copyText, safeFileName } from './lib/export'
import { noticeText } from './notice'
import { duration } from './time'
import { ChartView, TableView, ToolViewBody } from './Views'

const Markdown = lazy(() => import('./Markdown'))

type Tool = Extract<ThreadItem, { kind: 'tool' }>

/** The text before Markdown loads: no link targets or emphasis marks on show. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
}

function Mark({ status }: { status: ToolStatus }) {
  if (status === 'running')
    return <LoaderCircle className="step-mark pulse-icon" size={13} aria-hidden="true" />
  if (status === 'done') return <Check className="step-mark ok" size={13} aria-hidden="true" />
  if (status === 'stopped') return <Circle className="step-mark" size={8} aria-hidden="true" />
  return <TriangleAlert className="step-mark bad" size={13} aria-hidden="true" />
}

function statusLabel(status: ToolStatus, t: Dict): string {
  return status === 'running'
    ? t.runWorkRunning
    : status === 'failed'
      ? t.runWorkFailed
      : status === 'stopped'
        ? t.runWorkStopped
        : status === 'timeout'
          ? t.runWorkTimeout
          : status === 'refused'
            ? t.runWorkRefused
            : t.runWorkDone
}

/** One tool call where it happened: a line, and its shaped result on demand. */
function ToolStep({
  item,
  open,
  onToggle,
  t,
  lang,
  taskTitle,
  now,
}: {
  item: Tool
  open: boolean
  onToggle: () => void
  t: Dict
  lang: Lang
  taskTitle: string
  now: number
}) {
  const running = item.status === 'running'
  const elapsed =
    item.ms !== null
      ? duration(item.ms)
      : running
        ? duration(now - (Date.parse(item.at) || now))
        : null
  return (
    <li
      className={`step tool ${item.status}`}
      data-call-id={item.entryId ?? undefined}
      data-evidence-id={item.evidenceId ?? undefined}
    >
      <button className="step-line" type="button" aria-expanded={open} onClick={onToggle}>
        <Mark status={item.status} />
        <span className="step-title">{toolLabel(item.name, lang)}</span>
        {item.target && <span className="step-target mono">{item.target}</span>}
        {item.note && <span className="step-note">{item.note}</span>}
        {item.status !== 'done' && (
          <span className={`step-status ${item.status}`}>{statusLabel(item.status, t)}</span>
        )}
        {elapsed && <span className="step-time">{elapsed}</span>}
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="step-detail">
          {item.args && <p className="step-args mono">{item.args}</p>}
          {item.view?.kind === 'query' && (
            <>
              {item.view.chart && <ChartView chart={item.view.chart} />}
              <TableView
                table={item.view.rows}
                name={item.view.title}
                empty={t.noRows}
                t={t}
                limit={8}
              />
            </>
          )}
          {item.view ? (
            <ToolViewBody view={item.view} t={t} taskTitle={taskTitle} limit={8} />
          ) : running ? (
            <p className="quiet">{t.runWorkWaiting}</p>
          ) : item.note ? (
            <p className="step-detail-note">{item.note}</p>
          ) : null}
        </div>
      )}
    </li>
  )
}

/** The agent's plan, as it published it, where it published it. */
function PlanStep({ item, t }: { item: Tool; t: Dict }) {
  if (item.view?.kind !== 'plan') return null
  return (
    <li className="step agent-plan">
      <span className="step-title">{t.runPlanTitle}</span>
      {item.view.note && <span className="step-note">{item.view.note}</span>}
      <ol className="agent-plan-steps">
        {item.view.steps.map((step, index) => (
          <li key={`${step.title}:${index}`} className={`agent-plan-step ${step.status}`}>
            {step.status === 'done' ? (
              <Check size={12} aria-hidden="true" />
            ) : step.status === 'blocked' ? (
              <TriangleAlert size={12} aria-hidden="true" />
            ) : step.status === 'active' ? (
              <LoaderCircle size={12} className="pulse-icon" aria-hidden="true" />
            ) : (
              <Circle size={9} aria-hidden="true" />
            )}
            <span>{step.title}</span>
          </li>
        ))}
      </ol>
    </li>
  )
}

/** The agent asked; while it waits, the options answer it. */
function QuestionStep({
  item,
  pending,
  onAnswer,
}: {
  item: Tool
  pending: boolean
  onAnswer: (text: string) => void
}) {
  if (item.view?.kind !== 'question') return null
  return (
    <div className="msg agent question">
      <p>{item.view.question}</p>
      {item.view.note && <p className="quiet">{item.view.note}</p>}
      {pending && (
        <div className="question-options">
          {item.view.options.map((option, index) => (
            <button
              className="btn"
              type="button"
              key={`${option}:${index}`}
              onClick={() => onAnswer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The agent asked the user to accept a risk; only this click accepts it. */
function AcceptStep({ item, status, t }: { item: Tool; status: string | undefined; t: Dict }) {
  if (item.view?.kind !== 'accept') return null
  const { issue, accept } = item.view
  const done = accept ? status === 'accepted' : status === 'open'
  return (
    <div className="msg agent confirm">
      <p>
        {fill(accept ? t.confirmAccept : t.confirmReopen, {
          title: issue.title,
          bucket: issue.bucket || t.accountWide,
        })}
      </p>
      {status === 'resolved' ? (
        <p className="quiet">{t.confirmResolved}</p>
      ) : done ? (
        <p className="quiet">{accept ? t.confirmAccepted : t.confirmReopened}</p>
      ) : (
        <div className="question-options">
          <button
            className="btn primary"
            type="button"
            onClick={() => void window.agent.acceptIssue(issue.id, accept)}
          >
            {accept ? t.acceptRisk : t.reopen}
          </button>
        </div>
      )}
    </div>
  )
}

function Thought({ item, t }: { item: Extract<ThreadItem, { kind: 'thought' }>; t: Dict }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="step thought">
      <button
        className="step-line"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {item.running ? (
          <LoaderCircle className="step-mark pulse-icon" size={13} aria-hidden="true" />
        ) : (
          <Circle className="step-mark" size={8} aria-hidden="true" />
        )}
        <span className="step-title">{item.running ? t.thinking : t.runThought}</span>
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <p className="step-detail thought-text">
          {item.text ?? (item.running ? t.runWorkReasoningWaiting : t.runWorkNoReasoning)}
        </p>
      )}
    </li>
  )
}

function Menu({ view, items, t }: { view: TaskView; items: ThreadItem[]; t: Dict }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const timer = window.setTimeout(
      () => window.addEventListener('click', close, { once: true }),
      0,
    )
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', close)
    }
  }, [open])
  const item = (label: string, act: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false)
        act()
      }}
    >
      {label}
    </button>
  )
  return (
    <div className="conversation-menu brief-more">
      <button
        className="icon-btn"
        type="button"
        aria-label={t.moreActions}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="mini-menu" role="menu">
          {item(
            t.savePage,
            () =>
              void window.agent.saveText({
                name: safeFileName(view.task.title, 'md'),
                content: transcriptMarkdown(items),
                kind: 'markdown',
              }),
          )}
          {item(copied ? t.copied : t.copyLink, async () => {
            if (await copyText(`${TASK_LINK_PREFIX}${view.task.id}`)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }
          })}
          {item(
            t.exportEvidence,
            () =>
              void window.agent.saveText({
                name: safeFileName(`${view.task.title}-conversation`, 'json'),
                content: JSON.stringify({ task: view.task, items, usage: view.usage }, null, 2),
                kind: 'json',
              }),
          )}
          {item(t.savePdf, () => {
            window.dispatchEvent(new Event('sa:prepare-print'))
            setTimeout(() => void window.agent.exportPdf(), 80)
          })}
        </div>
      )}
    </div>
  )
}

function AgentText({
  text,
  streaming,
  t,
  onCite,
  resolves,
}: {
  text: string
  streaming: boolean
  t: Dict
  onCite: (evidenceId: string) => boolean
  /** Whether a call with this id is in the conversation; a link to nothing is not a button. */
  resolves: (evidenceId: string) => boolean
}) {
  const [copied, setCopied] = useState(false)
  const components = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      const raw = href?.match(/^#ev-(.+)$/)?.[1]
      if (raw && !resolves(decodeURIComponent(raw)))
        return (
          <sup className="cite missing" title={t.citeMissing}>
            {children}
          </sup>
        )
      if (raw)
        return (
          <button
            className="cite"
            type="button"
            data-ev={decodeURIComponent(raw)}
            onClick={() => onCite(decodeURIComponent(raw))}
          >
            {children}
          </button>
        )
      return href && /^https?:\/\//i.test(href) ? (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : (
        children
      )
    },
  }
  return (
    <div className={`msg agent text ${streaming ? 'streaming' : ''}`}>
      <div className="prose">
        <Suspense fallback={<p>{plain(text)}</p>}>
          <Markdown text={text} components={components} />
        </Suspense>
      </div>
      {!streaming && (
        <button
          className="msg-copy text-action"
          type="button"
          onClick={async () => {
            if (await copyText(text)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }
          }}
        >
          <Copy size={12} aria-hidden="true" />
          {copied ? t.copied : t.copyAnswer}
        </button>
      )}
    </div>
  )
}

/**
 * The task as a conversation: the user's messages and, between them, what the
 * agent did and said, in order. Steps (thoughts and tool calls) are compact
 * lines that open in place; the agent's text is plain Markdown.
 */
export function Conversation({
  view,
  lang,
  focusId,
  onRetry,
  onContinue,
  onAnswer,
  onOlder = async () => undefined,
  models = [],
  onModel,
}: {
  view: TaskView
  lang: Lang
  focusId: string | null
  onRetry: () => void
  onContinue: () => void
  onAnswer: (text: string) => void
  onOlder?: () => Promise<void>
  /** Models this machine runs; a task may use one instead of the Settings model. */
  models?: LocalModel[]
  onModel?: (model: TaskModel | null) => void
}) {
  const t = dict(lang)
  const items = useMemo(() => thread(view.entries, view.live), [view.entries, view.live])
  const pending = useMemo(() => (view.live ? null : pendingQuestion(items)), [items, view.live])
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const [printing, setPrinting] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [now, setNow] = useState(Date.now())
  const root = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)

  useEffect(() => {
    if (!view.live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [view.live])

  useEffect(() => {
    const print = () => setPrinting(true)
    window.addEventListener('sa:prepare-print', print)
    return () => window.removeEventListener('sa:prepare-print', print)
  }, [])

  // Follow the conversation as it grows, unless the user scrolled up to read.
  useEffect(() => {
    void items.length
    const element = root.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [items])

  const reveal = useCallback((id: string) => {
    setOpened((current) => new Set(current).add(id))
    setTimeout(() => {
      root.current
        ?.querySelector<HTMLElement>(
          `[data-call-id="${CSS.escape(id)}"], [data-item-id="${CSS.escape(id)}"]`,
        )
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 40)
  }, [])

  useEffect(() => {
    if (focusId) reveal(focusId)
  }, [focusId, reveal])

  const onCite = (evidenceId: string) => {
    const call = callFor(items, evidenceId)
    if (call?.kind !== 'tool' || !call.entryId) return false
    reveal(call.entryId)
    return true
  }
  const toggle = (id: string) =>
    setOpened((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Steps between two messages render as one list, so a turn reads top to bottom.
  const blocks: (ThreadItem | ThreadItem[])[] = []
  for (const item of latestPlans(items)) {
    // A question or a confirmation speaks to the user; a call that failed is a step like any other.
    const step =
      item.kind === 'thought' ||
      (item.kind === 'tool' && item.view?.kind !== 'question' && item.view?.kind !== 'accept')
    const last = blocks.at(-1)
    if (step && Array.isArray(last)) last.push(item)
    else blocks.push(step ? [item] : item)
  }
  const working =
    Boolean(view.live) &&
    !items.some((item) => item.id.startsWith('live:')) &&
    items.at(-1)?.kind === 'user'

  return (
    <div
      className="scroll conversation-scroll"
      ref={root}
      onScroll={(event) => {
        const element = event.currentTarget
        stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      }}
    >
      <article className="conversation" data-task-id={view.task.id}>
        <h1 className="visually-hidden">{view.task.title}</h1>
        <Menu view={view} items={items} t={t} />
        {view.hasOlder && (
          <button
            className="conversation-older"
            type="button"
            disabled={loadingOlder}
            onClick={async () => {
              setLoadingOlder(true)
              try {
                await onOlder()
              } finally {
                setLoadingOlder(false)
              }
            }}
          >
            {loadingOlder ? t.runLoadingEarlier : t.runLoadEarlier}
          </button>
        )}
        {blocks.map((block) => {
          if (Array.isArray(block))
            return (
              <ol className="steps" key={block[0]!.id}>
                {block.map((item) =>
                  item.kind === 'thought' ? (
                    <Thought key={item.id} item={item} t={t} />
                  ) : item.kind === 'tool' && item.name === 'plan' ? (
                    <PlanStep key={item.id} item={item} t={t} />
                  ) : item.kind === 'tool' ? (
                    <ToolStep
                      key={item.id}
                      item={item}
                      open={
                        printing || opened.has(item.entryId ?? item.id) || item.status === 'running'
                      }
                      onToggle={() => toggle(item.entryId ?? item.id)}
                      t={t}
                      lang={lang}
                      taskTitle={view.task.title}
                      now={now}
                    />
                  ) : null,
                )}
              </ol>
            )
          const item = block
          switch (item.kind) {
            case 'user':
              return (
                <div
                  className={`msg user ${item.steer ? 'steer' : ''}`}
                  key={item.id}
                  data-item-id={item.id}
                >
                  <p>{item.text}</p>
                  {(item.attachments.length > 0 || item.context?.length) && (
                    <div className="msg-chips">
                      {item.attachments.map((file) => (
                        <span className="chip" key={file.name}>
                          <Paperclip size={11} aria-hidden="true" /> {file.name}
                        </span>
                      ))}
                      {item.context?.map((ref) => (
                        <span className="chip" key={`${ref.kind}:${ref.label}`}>
                          @{ref.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            case 'text':
              return (
                <div key={item.id} data-item-id={item.id}>
                  <AgentText
                    text={item.text}
                    streaming={item.streaming}
                    t={t}
                    onCite={onCite}
                    resolves={(id) => Boolean(callFor(items, id))}
                  />
                </div>
              )
            case 'tool':
              return item.name === 'ask' ? (
                <QuestionStep
                  key={item.id}
                  item={item}
                  pending={pending === item.id}
                  onAnswer={onAnswer}
                />
              ) : (
                <AcceptStep
                  key={item.id}
                  item={item}
                  status={
                    item.view?.kind === 'accept' ? view.issueStatus[item.view.issue.id] : undefined
                  }
                  t={t}
                />
              )
            case 'notice':
              return (
                <div
                  className={`notice ${item.tone}`}
                  key={item.id}
                  role={item.tone === 'error' ? 'alert' : undefined}
                >
                  <span className="dot" aria-hidden="true" />
                  <span className="text">{noticeText(item, t)}</span>
                  {item.action && (
                    <button
                      className="text-action"
                      type="button"
                      onClick={item.action === 'retry' ? onRetry : onContinue}
                    >
                      {item.action === 'retry' ? t.retry : t.continue}
                    </button>
                  )}
                </div>
              )
            case 'resume':
              return (
                <p className="conversation-divider" key={item.id}>
                  {t.runWorkResumed}
                </p>
              )
            case 'compaction':
              return (
                <p className="conversation-divider" key={item.id}>
                  {t.runWorkCompacted}
                </p>
              )
            default:
              return null
          }
        })}
        {working && (
          <ol className="steps">
            <li className="step thought">
              <span className="step-line">
                <LoaderCircle className="step-mark pulse-icon" size={13} aria-hidden="true" />
                <span className="step-title">{t.thinking}</span>
              </span>
            </li>
          </ol>
        )}
        {!view.live && items.length === 0 && <p className="quiet">{t.runNoAnswer}</p>}
        {onModel && (models.length > 0 || view.model) && (
          <label className="conversation-model">
            <span>{t.model}</span>
            <select
              value={view.model?.modelId ?? ''}
              onChange={(event) => {
                const value = event.target.value
                const local = models.find((model) => model.modelId === value)
                if (!value) onModel(null)
                else if (local)
                  onModel({
                    provider: 'compatible',
                    modelId: local.modelId,
                    baseUrl: local.baseUrl,
                    thinking: 'off',
                  })
              }}
            >
              <option value="">{t.modelDefault}</option>
              {models.map((model) => (
                <option key={`${model.source}:${model.modelId}`} value={model.modelId}>
                  {model.source} · {model.modelId}
                </option>
              ))}
              {view.model && !models.some((model) => model.modelId === view.model?.modelId) && (
                <option value={view.model.modelId}>{view.model.modelId}</option>
              )}
            </select>
          </label>
        )}
      </article>
    </div>
  )
}
