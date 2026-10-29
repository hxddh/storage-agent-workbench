import {
  type Lang,
  type LocalModel,
  TASK_LINK_PREFIX,
  type TaskModel,
  type TaskView,
} from '@shared/contract'
import {
  buildTrace,
  earlierRuns,
  type RunTrace,
  resolveEvidence,
  traceMarkdown,
} from '@shared/trace'
import { ArrowDownToLine, Copy, Link2, MoreHorizontal, Radar } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Answer, EvidencePeek } from './Answer'
import { EarlierRuns } from './EarlierRuns'
import { Evidence } from './Evidence'
import { type Dict, dict, fill } from './i18n'
import { copyText, safeFileName } from './lib/export'
import { noticeText } from './notice'
import { scopeText } from './scope'
import { Trace } from './Trace'

function Notices({
  trace,
  t,
  onRetry,
  onContinue,
}: {
  trace: RunTrace
  t: Dict
  onRetry: () => void
  onContinue: () => void
}) {
  if (!trace.notices.length) return null
  return (
    <div className="run-notices">
      {trace.notices.map((notice) => (
        <div
          className={`notice ${notice.tone}`}
          key={notice.id}
          role={notice.tone === 'error' ? 'alert' : undefined}
        >
          <span className="dot" aria-hidden="true" />
          <span className="text">{noticeText(notice, t)}</span>
          {notice.action && (
            <button
              className="text-action"
              type="button"
              onClick={notice.action === 'retry' ? onRetry : onContinue}
            >
              {notice.action === 'retry' ? t.retry : t.continue}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function Clarify({
  clarify,
  t,
  onClarify,
}: {
  clarify: NonNullable<RunTrace['clarify']>
  t: Dict
  onClarify: (text: string) => void
}) {
  return (
    <section className="run-clarify" aria-label={t.runClarifyTitle}>
      <div className="run-section-head">
        <span className="run-section-title">{t.runClarifyTitle}</span>
        {clarify.note && <span className="run-section-note">{clarify.note}</span>}
      </div>
      <p className="run-clarify-question">{clarify.question}</p>
      <div className="run-clarify-options">
        {clarify.options.map((option, index) => (
          <button
            className="btn"
            type="button"
            key={`${option}:${index}`}
            onClick={() => onClarify(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </section>
  )
}

/** Header actions: copy the answer, and one overflow menu. */
function Actions({
  view,
  trace,
  t,
  checking,
  onCheck,
  onRecheck,
  onPrint,
}: {
  view: TaskView
  trace: RunTrace
  t: Dict
  checking: boolean
  onCheck: () => void
  onRecheck: () => void
  onPrint: () => void
}) {
  const [more, setMore] = useState(false)
  const [copied, setCopied] = useState<'answer' | 'link' | null>(null)
  useEffect(() => {
    if (!more) return
    const close = () => setMore(false)
    const timer = window.setTimeout(
      () => window.addEventListener('click', close, { once: true }),
      0,
    )
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMore(false)
      }
    }
    window.addEventListener('keydown', key)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', key)
    }
  }, [more])
  const flash = (what: 'answer' | 'link') => {
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }
  const item = (label: React.ReactNode, act: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setMore(false)
        act()
      }}
    >
      {label}
    </button>
  )
  return (
    <span className="run-actions">
      {trace.answer?.text && (
        <button
          className="text-action"
          type="button"
          onClick={async () => {
            if (await copyText(trace.answer?.text ?? '')) flash('answer')
          }}
        >
          <Copy size={12} aria-hidden="true" />
          {copied === 'answer' ? t.copied : t.copyAnswer}
        </button>
      )}
      <div className="brief-more">
        <button
          className="text-action"
          type="button"
          aria-label={t.moreActions}
          aria-expanded={more}
          onClick={() => setMore((value) => !value)}
        >
          <MoreHorizontal size={13} aria-hidden="true" />
        </button>
        {more && (
          <div className="mini-menu" role="menu">
            {item(
              <>
                <ArrowDownToLine size={13} aria-hidden="true" />
                {t.savePage}
              </>,
              () =>
                void window.agent.saveText({
                  name: safeFileName(view.task.title, 'md'),
                  content: traceMarkdown(trace),
                  kind: 'markdown',
                }),
            )}
            {item(
              <>
                <Radar size={13} aria-hidden="true" />
                {checking ? t.checkingAccount : t.checkAgain}
              </>,
              onCheck,
              checking,
            )}
            {item(t.reverify, onRecheck, Boolean(view.live))}
            {item(
              <>
                <Link2 size={13} aria-hidden="true" />
                {copied === 'link' ? t.copied : t.copyLink}
              </>,
              async () => {
                if (await copyText(`${TASK_LINK_PREFIX}${view.task.id}`)) flash('link')
              },
            )}
            {item(
              t.exportEvidence,
              () =>
                void window.agent.saveText({
                  name: safeFileName(`${view.task.title}-evidence`, 'json'),
                  content: JSON.stringify(
                    {
                      task: view.task,
                      request: trace.request,
                      answer: trace.answer,
                      plan: trace.plan,
                      trace: trace.items,
                      findings: trace.findings,
                      accepted: trace.accepted,
                      resolved: trace.resolved,
                      coverage: trace.read,
                      usage: trace.usage,
                    },
                    null,
                    2,
                  ),
                  kind: 'json',
                }),
            )}
            {item(t.savePdf, onPrint)}
          </div>
        )}
      </div>
    </span>
  )
}

export function Run({
  view,
  lang,
  focusId,
  onRetry,
  onContinue,
  onRecheck,
  onClarify,
  onOlder = async () => undefined,
  onCheck = () => undefined,
  checking = false,
  modelLabel = null,
  models = [],
  onModel,
}: {
  view: TaskView
  lang: Lang
  focusId: string | null
  modelLabel?: string | null
  models?: LocalModel[]
  onModel?: (model: TaskModel | null) => void
  onRetry: () => void
  onContinue: () => void
  onRecheck: () => void
  onClarify?: (text: string) => void
  onOlder?: () => Promise<void>
  onCheck?: () => void
  checking?: boolean
}) {
  const t = dict(lang)
  const trace = useMemo(
    () => buildTrace(view.entries, view.live, view.issueStatus, view.usage),
    [view.entries, view.live, view.issueStatus, view.usage],
  )
  const runs = useMemo(() => earlierRuns(view.entries), [view.entries])
  const [peekId, setPeekId] = useState<string | null>(null)
  const [traceOpen, setTraceOpen] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [panel, setPanel] = useState<'findings' | 'coverage' | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const peek = peekId ? resolveEvidence(trace, peekId) : undefined
  const runKey = trace.request?.id ?? trace.ledger.start
  // A re-check's result is its trace (what was re-read, what changed), so it opens there.
  const recheck = trace.scripted === 'recheck'

  useEffect(() => {
    void runKey
    setPeekId(null)
    setTraceOpen(recheck)
    setPanel(null)
  }, [runKey, recheck])

  const revealCall = useCallback((entryId?: string) => {
    setPeekId(null)
    setTraceOpen(true)
    setTimeout(() => {
      const element = entryId
        ? root.current?.querySelector<HTMLElement>(`[data-trace-id="${CSS.escape(entryId)}"]`)
        : root.current?.querySelector<HTMLElement>('.run-work')
      element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 40)
  }, [])

  useEffect(() => {
    if (!focusId) return
    if (focusId === 'answer' || focusId === `answer:${trace.answer?.id}`) {
      setTraceOpen(false)
      root.current
        ?.querySelector<HTMLElement>('.run-answer')
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    // An earlier run's answer opens under Earlier in this task.
    if (focusId.startsWith('answer:')) return
    if (focusId.startsWith('f:')) {
      const rest = focusId.slice(2)
      const key = rest.slice(rest.indexOf(':') + 1)
      const finding = [...trace.findings, ...trace.accepted].find((item) => item.key === key)
      setPanel('findings')
      if (finding) setPeekId(finding.sourceId)
      return
    }
    revealCall(focusId === 'reverify' ? undefined : focusId)
  }, [focusId, revealCall, trace.findings, trace.accepted, trace.answer?.id])

  const live = Boolean(view.live)
  const stopped = trace.phase === 'stopped'
  const traceFirst =
    !trace.answer && (trace.phase === 'planning' || trace.phase === 'investigating')
  const noticesFirst = stopped || trace.phase === 'failed'
  const showPlan =
    live || stopped || Boolean(trace.plan?.steps.some((step) => step.status === 'blocked'))

  const traceSection = (
    <Trace
      trace={trace}
      live={view.live}
      showPlan={showPlan}
      open={traceOpen || live || printing}
      onToggle={() => setTraceOpen((value) => !value)}
      t={t}
      lang={lang}
      taskTitle={view.task.title}
    />
  )
  const answerSection = <Answer trace={trace} live={live} t={t} onCite={setPeekId} />
  const notices = <Notices trace={trace} t={t} onRetry={onRetry} onContinue={onContinue} />
  const chooseModel = (value: string) => {
    if (!onModel) return
    if (!value) return onModel(null)
    const local = models.find((model) => model.modelId === value)
    if (local)
      onModel({
        provider: 'compatible',
        modelId: local.modelId,
        baseUrl: local.baseUrl,
        thinking: 'off',
      })
  }

  return (
    <div className="scroll" ref={root}>
      <article className="brief run" data-task-id={view.task.id}>
        <h1 className="visually-hidden">{view.task.title}</h1>
        <header className="run-header">
          <div className="run-headline">
            <p className="run-scope">{scopeText(trace, t)}</p>
            <Actions
              view={view}
              trace={trace}
              t={t}
              checking={checking}
              onCheck={onCheck}
              onRecheck={onRecheck}
              onPrint={() => {
                setPrinting(true)
                window.dispatchEvent(new Event('sa:prepare-print'))
                setTimeout(() => void window.agent.exportPdf(), 80)
              }}
            />
          </div>
          {trace.request && <h2 className="run-question">{trace.request.text}</h2>}
          {trace.scripted && (
            <div className="run-facts">
              <span className="run-tag">
                {trace.scripted === 'recheck' ? t.runRecheck : t.runSynthesized}
              </span>
            </div>
          )}
        </header>

        {view.hasOlder && (
          <button
            className="run-older"
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

        <EarlierRuns
          runs={runs}
          focus={focusId?.startsWith('answer:') ? focusId.slice('answer:'.length) : null}
          t={t}
        />
        {noticesFirst && notices}
        {trace.phase === 'clarifying' && trace.clarify && (
          <Clarify clarify={trace.clarify} t={t} onClarify={(text) => onClarify?.(text)} />
        )}
        {!noticesFirst && notices}
        {traceFirst ? traceSection : answerSection}
        {traceFirst ? answerSection : traceSection}

        {!live && (
          <Evidence trace={trace} open={panel} onOpen={setPanel} onReveal={revealCall} t={t} />
        )}

        {peek?.view && (
          <EvidencePeek
            item={peek}
            t={t}
            lang={lang}
            taskTitle={view.task.title}
            onClose={() => setPeekId(null)}
            onOpen={() => revealCall(peek.entryId)}
          />
        )}

        <footer className="run-meta">
          <div className="run-model">
            <span>{t.model}</span>
            {onModel ? (
              <select
                aria-label={t.model}
                value={view.model?.modelId ?? ''}
                onChange={(event) => chooseModel(event.target.value)}
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
            ) : (
              <span>{view.model?.modelId ?? modelLabel ?? t.noModel}</span>
            )}
          </div>
          <span>
            {trace.calls === 1 ? t.runWorkCallOne : fill(t.runWorkCalls, { n: trace.calls })}
          </span>
          {trace.usage && trace.usage.input + trace.usage.output > 0 && (
            <span>{fill(t.tokens, { n: trace.usage.input + trace.usage.output })}</span>
          )}
          {trace.usage && trace.usage.cost > 0 && <span>${trace.usage.cost.toFixed(4)}</span>}
        </footer>
      </article>
    </div>
  )
}
