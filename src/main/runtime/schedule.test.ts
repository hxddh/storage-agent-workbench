import { describe, expect, it } from 'vitest'
import { isScheduleDue, scheduleInterval } from './schedule'

describe('scheduled checks', () => {
  const now = Date.parse('2026-01-08T12:00:00Z')

  it('never schedules an account that is off', () => {
    expect(scheduleInterval('off')).toBeNull()
    expect(isScheduleDue('off', null, now)).toBe(false)
  })

  it('runs daily or weekly only after the interval', () => {
    expect(isScheduleDue('daily', null, now)).toBe(true)
    expect(isScheduleDue('daily', '2026-01-08T11:59:00Z', now)).toBe(false)
    expect(isScheduleDue('daily', '2026-01-07T12:00:00Z', now)).toBe(true)
    expect(isScheduleDue('weekly', '2026-01-02T12:00:00Z', now)).toBe(false)
    expect(isScheduleDue('weekly', '2026-01-01T12:00:00Z', now)).toBe(true)
  })

  it('treats an invalid timestamp as due rather than stalled', () => {
    expect(isScheduleDue('daily', 'not-a-date', now)).toBe(true)
  })
})
