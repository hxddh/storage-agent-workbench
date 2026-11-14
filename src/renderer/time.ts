import { useEffect, useState } from 'react'
import { type Dict, fill } from './i18n'

/** A compact duration for a tool call or a whole run. */
export function duration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** A clock for relative times; the list does not have to wait for an event. */
export function useNow(interval = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [interval])
  return now
}

/** Relative time shared by the run, evidence and task list surfaces. */
export function ago(iso: string, t: Dict): string | null {
  const started = Date.parse(iso)
  if (Number.isNaN(started)) return null
  const seconds = Math.max(0, (Date.now() - started) / 1000)
  if (seconds < 60) return t.justNow
  if (seconds < 3600) return fill(t.minutesAgo, { n: Math.floor(seconds / 60) })
  if (seconds < 86_400) return fill(t.hoursAgo, { n: Math.floor(seconds / 3600) })
  return fill(t.daysAgo, { n: Math.floor(seconds / 86_400) })
}
