import type { RunSummary } from '@shared/trace'
import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Dict, fill } from './i18n'
import { ago } from './time'

function plain(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\[([^\]]*)\]\(#ev-[^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Earlier runs of the task: compact rows, each expanding to its answer. */
export function EarlierRuns({
  runs,
  focus = null,
  t,
}: {
  runs: RunSummary[]
  /** An answer entry a search hit points at; its run opens. */
  focus?: string | null
  t: Dict
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    const run = focus ? runs.find((item) => item.answerId === focus) : undefined
    if (!run) return
    setOpen(true)
    setSelected(run.id)
  }, [focus, runs])
  if (!runs.length) return null
  return (
    <section className="run-history" aria-label={t.runEarlier}>
      <button
        className="run-history-head"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="run-section-title">{t.runEarlier}</span>
        <span className="run-history-count">{runs.length}</span>
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <ol className="run-turn-list">
          {runs.map((run) => {
            const expanded = selected === run.id
            return (
              <li key={run.id} className="run-turn">
                <button
                  className="run-turn-head"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setSelected(expanded ? null : run.id)}
                >
                  <span className="run-turn-question">
                    {run.request ??
                      (run.scripted === 'recheck' ? t.runRecheck : t.runDeterministicCheck)}
                  </span>
                  <span className="run-turn-meta">
                    {ago(run.at, t) ?? ''} ·{' '}
                    {run.calls === 1 ? t.runWorkCallOne : fill(t.runWorkCalls, { n: run.calls })}
                  </span>
                  <ChevronRight size={13} className={`chev ${expanded ? 'open' : ''}`} />
                </button>
                {expanded && (
                  <div className="run-turn-body">
                    {run.answer ? (
                      <p className="run-turn-summary">{plain(run.answer).slice(0, 700)}</p>
                    ) : (
                      <p className="quiet">{t.runNoAnswer}</p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
