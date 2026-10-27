import { type Dict, fill } from './i18n'

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
