/**
 * Work the agent schedules for later.
 *
 * A schedule is a prompt, a cadence and an unattended budget. Each one owns a
 * task of its own (a conversation the user can open, steer or stop) and a pi
 * durable task, `sa.schedule`, that sleeps until the run is due, starts the
 * turn and sleeps again. pi owns the timing and survives restarts: a run that
 * fell due while the app was closed runs once when it opens, and the next is
 * counted from then. There is no second queue.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import { defineTask } from '@earendil-works/pi-durable'
import type { AppDb, ScheduleRecord } from '../db'

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** The shortest gap between two runs of one schedule. */
export const MIN_INTERVAL_MINUTES = 5

/** A run's token budget when the schedule names none. */
export const DEFAULT_BUDGET_TOKENS = 100_000

/**
 * A cadence, normalised, or the reason it is not one. Accepted:
 * `at <ISO time>`, `every <n>m`, `every <n>h`, `daily HH:MM`,
 * `weekly <day> HH:MM` — local time.
 */
export function parseCadence(text: string): string {
  const value = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  const at = /^at (.+)$/.exec(value)?.[1]
  if (at) {
    const when = Date.parse(at.toUpperCase().replace(' ', 'T'))
    if (Number.isNaN(when))
      throw new Error(`"${at}" is not a time; give an ISO time, e.g. at 2026-12-01T09:00.`)
    return `at ${new Date(when).toISOString()}`
  }
  const every = /^every (\d+) ?(m|min|minutes?|h|hours?)$/.exec(value)
  if (every) {
    const minutes = Number(every[1]) * (every[2]!.startsWith('h') ? 60 : 1)
    if (minutes < MIN_INTERVAL_MINUTES)
      throw new Error(`A schedule runs at most every ${MIN_INTERVAL_MINUTES} minutes.`)
    return `every ${minutes}m`
  }
  const daily = /^daily (\d{1,2}):(\d{2})$/.exec(value)
  if (daily && Number(daily[1]) < 24 && Number(daily[2]) < 60)
    return `daily ${daily[1]!.padStart(2, '0')}:${daily[2]}`
  const weekly = /^weekly ([a-z]+) (\d{1,2}):(\d{2})$/.exec(value)
  if (weekly) {
    const day = DAYS.find((name) => name.startsWith(weekly[1]!.slice(0, 3)))
    if (day && Number(weekly[2]) < 24 && Number(weekly[3]) < 60)
      return `weekly ${day} ${weekly[2]!.padStart(2, '0')}:${weekly[3]}`
  }
  throw new Error(
    `"${text}" is not a cadence. Use: at <ISO time>, every <n>m, every <n>h, daily HH:MM or weekly <day> HH:MM (local time).`,
  )
}

/** The next run strictly after `from`, in local time; null when a one-off run has passed. */
export function nextRun(cadence: string, from: number): number | null {
  const [kind, ...rest] = cadence.split(' ')
  if (kind === 'at') {
    const when = Date.parse(rest.join(' '))
    return when > from ? when : null
  }
  if (kind === 'every') return from + Number.parseInt(rest[0] ?? '60', 10) * 60_000
  const time = (kind === 'daily' ? rest[0] : rest[1]) ?? '09:00'
  const [hours, minutes] = time.split(':').map(Number)
  const next = new Date(from)
  next.setSeconds(0, 0)
  next.setHours(hours ?? 9, minutes ?? 0)
  if (kind === 'daily') {
    if (next.getTime() <= from) next.setDate(next.getDate() + 1)
    return next.getTime()
  }
  const day = DAYS.indexOf(rest[0] ?? 'monday')
  let ahead = (day - next.getDay() + 7) % 7
  if (ahead === 0 && next.getTime() <= from) ahead = 7
  next.setDate(next.getDate() + ahead)
  return next.getTime()
}

/** What the host does when a run is due; it returns the next run, or null to stop. */
export interface ScheduleHost {
  fire(scheduleId: string, dueAt: number, context: Context): Promise<number | null>
}

type ScheduleState = { phase: 'wait'; at: number } | { phase: 'fire'; at: number }

/** The durable timer of one schedule. The host is bound late: the task resolves it when it runs. */
export function scheduleTask(host: () => ScheduleHost | null) {
  return defineTask<{ scheduleId: string; firstAt: number }, ScheduleState, null>({
    name: 'sa.schedule',
    version: 1,
    initial: (input) => ({ phase: 'wait', at: input.firstAt }),
    phases: {
      wait: async (task, runtime, context) => {
        await runtime.sleepUntil(
          task.state.checkpoint.at,
          { phase: 'fire', at: task.state.checkpoint.at },
          context,
        )
      },
      fire: async (task, runtime, context) => {
        const bound = host()
        // Before the app has wired the engine, try again shortly.
        if (!bound) {
          await runtime.sleepUntil(runtime.now() + 30_000, task.state.checkpoint, context)
          return
        }
        const next = await bound.fire(task.input.scheduleId, task.state.checkpoint.at, context)
        if (next === null) {
          await runtime.commit(
            () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
            context,
          )
          return
        }
        await runtime.sleepUntil(next, { phase: 'fire', at: next }, context)
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
}

export interface ScheduleView {
  name: string
  prompt: string
  cadence: string
  budgetTokens: number
  taskId: string | null
  nextAt: string | null
  lastAt: string | null
  lastOutcome: string | null
  createdBy: string | null
}

export function viewOf(row: ScheduleRecord): ScheduleView {
  return {
    name: row.name,
    prompt: row.prompt,
    cadence: row.cadence,
    budgetTokens: row.budget_tokens ?? DEFAULT_BUDGET_TOKENS,
    taskId: row.conversation_id,
    nextAt: row.next_at,
    lastAt: row.last_at,
    lastOutcome: row.last_outcome,
    createdBy: row.created_by,
  }
}

export function newSchedule(input: {
  name: string
  prompt: string
  cadence: string
  budgetTokens?: number | null
  createdBy: string | null
  now: number
}): ScheduleRecord {
  const name = input.name.trim()
  if (!/^[\w .-]{2,60}$/.test(name))
    throw new Error('A schedule name is 2–60 letters, digits, spaces, dots, dashes or underscores.')
  if (!input.prompt.trim()) throw new Error('A schedule needs the prompt each run starts with.')
  const cadence = parseCadence(input.cadence)
  const next = nextRun(cadence, input.now)
  if (next === null) throw new Error('That time has passed.')
  const budget = input.budgetTokens ?? null
  if (budget !== null && (!Number.isInteger(budget) || budget < 1_000))
    throw new Error('A run budget is a whole number of tokens, at least 1,000.')
  return {
    id: randomUUID(),
    name,
    prompt: input.prompt.trim(),
    cadence,
    budget_tokens: budget,
    conversation_id: null,
    task_id: null,
    created_by: input.createdBy,
    next_at: new Date(next).toISOString(),
    last_at: null,
    last_outcome: null,
    enabled: 1,
    created_at: new Date(input.now).toISOString(),
  }
}

export type { AppDb }
