import type { CheckSchedule } from '@shared/contract'

const DAY = 24 * 60 * 60 * 1000

/** How long a schedule waits between starts. Off never becomes due. */
export function scheduleInterval(schedule: CheckSchedule | undefined): number | null {
  if (schedule === 'daily') return DAY
  if (schedule === 'weekly') return 7 * DAY
  return null
}

/** A missing last reading counts as due, so the first enabled check runs now. */
export function isScheduleDue(
  schedule: CheckSchedule | undefined,
  lastAt: string | null | undefined,
  now = Date.now(),
): boolean {
  const interval = scheduleInterval(schedule)
  if (interval === null) return false
  if (!lastAt) return true
  const timestamp = Date.parse(lastAt)
  return !Number.isFinite(timestamp) || now - timestamp >= interval
}
