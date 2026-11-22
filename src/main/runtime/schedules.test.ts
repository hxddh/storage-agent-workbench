import { describe, expect, it } from 'vitest'
import { newSchedule, nextRun, parseCadence } from './schedules'

describe('schedules', () => {
  it('reads the cadences a person writes, and says what it accepts otherwise', () => {
    expect(parseCadence('Every 2h')).toBe('every 120m')
    expect(parseCadence('every 30 minutes')).toBe('every 30m')
    expect(parseCadence('daily 9:05')).toBe('daily 09:05')
    expect(parseCadence('weekly Mon 18:00')).toBe('weekly monday 18:00')
    expect(() => parseCadence('every 1m')).toThrow(/at most every 5 minutes/)
    expect(() => parseCadence('sometimes')).toThrow(/daily HH:MM/)
  })

  it('finds the next run in local time', () => {
    const from = new Date(2026, 10, 22, 10, 0).getTime() // Sunday 10:00 local
    expect(new Date(nextRun('daily 09:00', from)!).getDate()).toBe(23)
    expect(new Date(nextRun('daily 11:30', from)!).getHours()).toBe(11)
    expect(new Date(nextRun('weekly monday 08:00', from)!).getDay()).toBe(1)
    expect(new Date(nextRun('weekly sunday 08:00', from)!).getDate()).toBe(29)
    expect(nextRun('every 60m', from)).toBe(from + 3_600_000)
    const once = parseCadence(`at ${new Date(from + 60_000).toISOString()}`)
    expect(nextRun(once, from)).toBe(from + 60_000)
    expect(nextRun(once, from + 120_000)).toBeNull()
  })

  it('refuses a schedule without a prompt, with a past time or a tiny budget', () => {
    const now = Date.now()
    const base = {
      name: 'Public check',
      prompt: 'Check',
      cadence: 'daily 09:00',
      createdBy: null,
      now,
    }
    expect(newSchedule(base).next_at).toBeTruthy()
    expect(() => newSchedule({ ...base, prompt: ' ' })).toThrow(/prompt/)
    expect(() => newSchedule({ ...base, cadence: 'at 2020-01-01T00:00' })).toThrow(/passed/)
    expect(() => newSchedule({ ...base, budgetTokens: 10 })).toThrow(/at least 1,000/)
  })
})
