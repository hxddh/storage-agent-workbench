import type { ActivityItem, Activity as ActivityModel } from '@shared/activity'
import type { Lang, Live, ToolStatus } from '@shared/contract'
import { Check, ChevronRight, Circle, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Dict, fill, toolLabel } from './i18n'
import { duration } from './time'
import { ToolViewBody } from './Views'

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

function ActivityMark({ status }: { status: ToolStatus }) {
  if (status === 'running')
    return <LoaderCircle className="activity-mark pulse-icon" size={13} aria-hidden="true" />
  if (status === 'done') return <Check className="activity-mark ok" size={13} aria-hidden="true" />
  if (status === 'failed' || status === 'timeout' || status === 'refused')
    return <TriangleAlert className="activity-mark bad" size={13} aria-hidden="true" />
  return <Circle className="activity-mark" size={8} aria-hidden="true" />
}

function Row({
  item,
  t,
  lang,
  taskTitle,
  now,
}: {
  item: ActivityItem
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
      ? Boolean(
          item.view ||
            running ||
            item.status === 'failed' ||
            item.status === 'stopped' ||
            item.status === 'timeout' ||
            item.status === 'refused',
        )
      : item.kind === 'reasoning'
  const open = manual ?? (running || (item.kind === 'tool' && item.status === 'failed'))

  const title =
    item.kind === 'reasoning'
      ? status === 'running'
        ? t.thinking
        : t.runThought
      : item.kind === 'tool'
        ? toolLabel(item.name, lang)
        : item.kind === 'compaction'
          ? t.runWorkCompacted
          : t.runWorkResumed
  const target = item.kind === 'tool' ? item.target : ''
  const note = item.kind === 'tool' ? item.note : item.kind === 'reasoning' ? item.text : null
  const elapsed =
    item.kind === 'tool'
      ? item.durationMs !== null
        ? duration(item.durationMs)
        : running
          ? duration(now - (Date.parse(item.startedAt) || now))
          : null
      : item.kind === 'reasoning' && running
        ? duration(now - (Date.parse(item.startedAt) || now))
        : null

  const line = (
    <>
      {status ? <ActivityMark status={status} /> : <Circle className="activity-mark" size={8} />}
      <span className="activity-copy">
        <span className="activity-title">{title}</span>
        {target && <span className="activity-target mono">{target}</span>}
        {note && <span className="activity-note">{note}</span>}
      </span>
      {status && (
        <span className={`activity-status ${status}`}>
          {running ? statusLabel(status, t) : status !== 'done' ? statusLabel(status, t) : null}
          <span className="visually-hidden">{status === 'done' ? statusLabel(status, t) : ''}</span>
        </span>
      )}
      {elapsed && <span className="activity-time">{elapsed}</span>}
      {expandable && <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />}
    </>
  )

  return (
    <li className={`activity-item ${item.kind} ${status ?? ''}`}>
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
          ) : item.kind === 'tool' && item.view ? (
            <ToolViewBody view={item.view} t={t} taskTitle={taskTitle} limit={8} />
          ) : item.kind === 'tool' && running ? (
            <p className="quiet">{t.runWorkWaiting}</p>
          ) : item.kind === 'tool' && note ? (
            <p className="activity-detail-note">{note}</p>
          ) : null}
        </div>
      )}
    </li>
  )
}

/**
 * The current turn's work. It is open while the run is live and becomes one
 * quiet disclosure after the answer settles. It is deliberately not a chat
 * transcript: plan and methods stay separate, and every row is evidence or
 * provider-supplied reasoning.
 */
export function Work({
  activity,
  live,
  open,
  onToggle,
  t,
  lang,
  taskTitle,
}: {
  activity: ActivityModel
  live: Live | null
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

  if (!live && activity.items.length === 0) return null

  const active = [...activity.items]
    .reverse()
    .find(
      (item): item is Extract<ActivityItem, { kind: 'tool' }> =>
        item.kind === 'tool' && item.status === 'running',
    )
  const lastTool = [...activity.items]
    .reverse()
    .find((item): item is Extract<ActivityItem, { kind: 'tool' }> => item.kind === 'tool')
  const failed = lastTool?.status === 'failed' ? lastTool : undefined
  const liveElapsed = live ? duration(now - (Date.parse(live.startedAt) || now)) : null
  const calls =
    activity.calls === 1 ? t.runWorkCallOne : fill(t.runWorkCalls, { n: activity.calls })
  const settledTime = duration(activity.durationMs)
  const settled = [
    settledTime ? fill(t.runWorkedFor, { time: settledTime }) : null,
    activity.calls > 0
      ? calls
      : activity.items.some((item) => item.kind === 'reasoning')
        ? t.runWorkReasoning
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
        <ol className="activity-list">
          {activity.items.map((item) => (
            <Row key={item.id} item={item} t={t} lang={lang} taskTitle={taskTitle} now={now} />
          ))}
        </ol>
      )}
    </section>
  )
}
