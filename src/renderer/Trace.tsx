import type { Lang, Live, ToolStatus } from '@shared/contract'
import type { RunPlan, RunTrace, TraceItem } from '@shared/trace'
import { Check, ChevronRight, Circle, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Dict, fill, toolLabel } from './i18n'
import { duration } from './time'
import { ChartView, TableView, ToolViewBody } from './Views'

function statusLabel(status: ToolStatus, t: Dict): string {
  return status === 'running'
    ? t.runWorkRunning
    : status === 'done'
      ? t.runWorkDone
      : status === 'failed'
        ? t.runWorkFailed
        : status === 'stopped'
          ? t.runWorkStopped
          : status === 'timeout'
            ? t.runWorkTimeout
            : t.runWorkRefused
}

function Mark({ status }: { status: ToolStatus }) {
  if (status === 'running')
    return <LoaderCircle className="activity-mark pulse-icon" size={13} aria-hidden="true" />
  if (status === 'done') return <Check className="activity-mark ok" size={13} aria-hidden="true" />
  if (status === 'failed' || status === 'timeout' || status === 'refused')
    return <TriangleAlert className="activity-mark bad" size={13} aria-hidden="true" />
  return <Circle className="activity-mark" size={8} aria-hidden="true" />
}

function PlanBlock({ plan, t }: { plan: RunPlan; t: Dict }) {
  return (
    <div className="run-work-plan">
      <div className="run-work-plan-head">
        <span className="run-section-title">{t.runPlanTitle}</span>
        <span className="run-section-note">{plan.note ?? t.runAgentPlan}</span>
      </div>
      <ol className="run-plan-list">
        {plan.steps.map((step, index) => (
          <li key={`${step.title}:${index}`} className={`run-step ${step.status}`}>
            <span className="run-step-mark" aria-hidden="true">
              {step.status === 'done' ? (
                <Check size={12} />
              ) : step.status === 'blocked' ? (
                <TriangleAlert size={12} />
              ) : step.status === 'active' ? (
                <LoaderCircle size={12} className="pulse-icon" />
              ) : (
                <Circle size={9} />
              )}
            </span>
            <span className="run-step-title">{step.title}</span>
            {step.detail && <span className="run-step-detail">{step.detail}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}

function Recheck({
  report,
  t,
}: {
  report: Extract<TraceItem, { kind: 'reverify' }>['report']
  t: Dict
}) {
  return (
    <div className="activity-reverify">
      {report.plan && (
        <p className="quiet">
          {fill(t.planReverifySummary, {
            confirmed: report.plan.confirmed,
            notApplied: report.plan.notApplied,
            unknown: report.plan.unknown,
          })}
        </p>
      )}
      {report.plan?.steps.map((step) => (
        <p className="reverify-plan-row" key={`${step.bucket}:${step.code}`}>
          <span className={`plan-status ${step.status}`}>
            {step.status === 'confirmed'
              ? t.planStatusConfirmed
              : step.status === 'not_applied'
                ? t.planStatusNotApplied
                : t.planStatusUnknown}
          </span>
          <span className="mono">{step.bucket || t.accountWide}</span> · {step.title}
        </p>
      ))}
      {report.changes.length === 0 ? (
        <p className="quiet">{t.reverifyNoChange}</p>
      ) : (
        report.changes.slice(0, 12).map((change) => (
          <p className="reverify-plan-row" key={`${change.bucket}:${change.code}`}>
            <span className="mono">{change.bucket || t.accountWide}</span> · {change.title}
          </p>
        ))
      )}
    </div>
  )
}

/** What the rules did with a reading, in one clause. The model never does this. */
function assessedText(item: Extract<TraceItem, { kind: 'tool' }>, t: Dict): string | null {
  const assessed = item.assessed
  if (!assessed) return null
  return fill(t.runAssessed, { opened: assessed.opened, resolved: assessed.resolved })
}

function titleOf(item: TraceItem, t: Dict, lang: Lang): string {
  switch (item.kind) {
    case 'reasoning':
      return item.status === 'running' ? t.thinking : t.runThought
    case 'tool':
      return toolLabel(item.name, lang)
    case 'steer':
      return t.runSteer
    case 'validation':
      return t.runValidation
    case 'compaction':
      return t.runWorkCompacted
    case 'reverify':
      return t.reverifyTitle
    default:
      return t.runWorkResumed
  }
}

function Row({
  item,
  t,
  lang,
  taskTitle,
  now,
}: {
  item: TraceItem
  t: Dict
  lang: Lang
  taskTitle: string
  now: number
}) {
  const [manual, setManual] = useState<boolean | null>(null)
  const status = item.kind === 'tool' || item.kind === 'reasoning' ? item.status : null
  const running = status === 'running'
  const expandable =
    item.kind === 'tool'
      ? Boolean(item.view || running || item.status !== 'done')
      : item.kind === 'reasoning' || item.kind === 'reverify'
  const open = manual ?? (running || (item.kind === 'tool' && item.status === 'failed'))
  const target = item.kind === 'tool' ? item.target : ''
  const note =
    item.kind === 'tool'
      ? [item.note, assessedText(item, t)].filter(Boolean).join(' · ') || null
      : item.kind === 'reasoning' || item.kind === 'steer' || item.kind === 'validation'
        ? item.text
        : item.kind === 'reverify'
          ? fill(t.reverifyChecked, { n: item.report.checked, changed: item.report.changes.length })
          : null
  const elapsed =
    item.kind === 'tool'
      ? item.durationMs !== null
        ? duration(item.durationMs)
        : running
          ? duration(now - (Date.parse(item.at) || now))
          : null
      : item.kind === 'reasoning' && running
        ? duration(now - (Date.parse(item.at) || now))
        : null

  const line = (
    <>
      {status ? (
        <Mark status={status} />
      ) : item.kind === 'validation' ? (
        <TriangleAlert className="activity-mark warn" size={13} aria-hidden="true" />
      ) : (
        <Circle className="activity-mark" size={8} />
      )}
      <span className="activity-copy">
        <span className="activity-title">{titleOf(item, t, lang)}</span>
        {target && <span className="activity-target mono">{target}</span>}
        {note && <span className="activity-note">{note}</span>}
      </span>
      {status && (
        <span className={`activity-status ${status}`}>
          {status !== 'done' ? statusLabel(status, t) : null}
          <span className="visually-hidden">{status === 'done' ? statusLabel(status, t) : ''}</span>
        </span>
      )}
      {elapsed && <span className="activity-time">{elapsed}</span>}
      {expandable && <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />}
    </>
  )

  return (
    <li
      className={`activity-item ${item.kind} ${status ?? ''}`}
      data-trace-id={item.kind === 'tool' ? item.entryId : undefined}
      data-evidence-id={item.kind === 'tool' ? item.evidenceId : undefined}
    >
      {expandable ? (
        <button
          className="activity-line"
          type="button"
          aria-expanded={open}
          onClick={() => setManual(!open)}
        >
          {line}
        </button>
      ) : (
        <div className="activity-line">{line}</div>
      )}
      {expandable && open && (
        <div className="activity-detail">
          {item.kind === 'reasoning' ? (
            <p className="activity-thought">
              {item.text ? item.text : running ? t.runWorkReasoningWaiting : t.runWorkNoReasoning}
            </p>
          ) : item.kind === 'reverify' ? (
            <Recheck report={item.report} t={t} />
          ) : item.kind === 'tool' ? (
            <>
              {item.args && <p className="activity-args mono">{item.args}</p>}
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
              ) : note ? (
                <p className="activity-detail-note">{note}</p>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </li>
  )
}

/**
 * The run's one record: plan revisions, provider reasoning, every call with its
 * status and shaped result, validations, steers and re-checks, in order. It is
 * primary while the run works and folds to one row once the answer settles.
 */
export function Trace({
  trace,
  live,
  showPlan,
  open,
  onToggle,
  t,
  lang,
  taskTitle,
}: {
  trace: RunTrace
  live: Live | null
  showPlan: boolean
  open: boolean
  onToggle: () => void
  t: Dict
  lang: Lang
  taskTitle: string
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  const plan = showPlan || open ? trace.plan : null
  if (!live && trace.items.length === 0 && !plan) return null

  const tools = trace.items.filter(
    (item): item is Extract<TraceItem, { kind: 'tool' }> => item.kind === 'tool',
  )
  const active = tools.findLast((item) => item.status === 'running')
  const failed = tools.at(-1)?.status === 'failed' ? tools.at(-1) : undefined
  const liveElapsed = live ? duration(now - (Date.parse(live.startedAt) || now)) : null
  const settledTime = duration(trace.durationMs)
  const settled = [
    settledTime ? fill(t.runWorkedFor, { time: settledTime }) : null,
    trace.calls > 0
      ? trace.calls === 1
        ? t.runWorkCallOne
        : fill(t.runWorkCalls, { n: trace.calls })
      : trace.items.some((item) => item.kind === 'reasoning')
        ? t.runWorkReasoning
        : trace.plan
          ? t.runPlanTitle
          : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const liveDetail = active
    ? `${t.runWorkRunning}${liveElapsed ? ` · ${liveElapsed}` : ''}`
    : failed
      ? `${toolLabel(failed.name, lang)}: ${t.runWorkFailed}`
      : live?.phase === 'writing'
        ? `${t.writing}${liveElapsed ? ` · ${liveElapsed}` : ''}`
        : `${t.thinking}${liveElapsed ? ` · ${liveElapsed}` : ''}`

  return (
    <section className="run-work" aria-label={t.runWork}>
      <button
        className={`run-work-head ${open ? 'open' : ''}`}
        type="button"
        aria-expanded={open}
        disabled={Boolean(live)}
        onClick={onToggle}
      >
        <span className="run-section-title">{t.runWork}</span>
        <span className="run-work-detail">{live ? liveDetail : settled}</span>
        {!live && <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />}
      </button>
      {open && (
        <>
          {plan && <PlanBlock plan={plan} t={t} />}
          <ol className="activity-list">
            {trace.items.map((item) => (
              <Row key={item.id} item={item} t={t} lang={lang} taskTitle={taskTitle} now={now} />
            ))}
          </ol>
        </>
      )}
    </section>
  )
}
