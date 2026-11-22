import type { Context } from '@earendil-works/chord/context'
import type { Engine } from './engine'
import {
  DEFAULT_BUDGET_TOKENS,
  newSchedule,
  nextRun,
  type ScheduleHost,
  type ScheduleView,
  viewOf,
} from './schedules'
import { CONTEXT, type Runtime } from './session'
import type { Tasks } from './tasks'

/** Creates, lists and cancels schedules, and runs each one when pi says it is due. */
export class Scheduler implements ScheduleHost {
  constructor(
    private readonly runtime: Runtime,
    private readonly tasks: Tasks,
    private readonly engine: Engine,
  ) {}

  private get db() {
    return this.runtime.deps.db
  }

  async list(): Promise<ScheduleView[]> {
    return (await this.db.listSchedules()).map(viewOf)
  }

  async create(input: {
    name: string
    prompt: string
    cadence: string
    budgetTokens?: number | null
    createdBy: string | null
  }): Promise<ScheduleView> {
    if (await this.db.scheduleByName(input.name.trim()))
      throw new Error(
        `A schedule named "${input.name.trim()}" exists; cancel it first or choose another name.`,
      )
    const row = newSchedule({ ...input, now: Date.now() })
    // Each schedule's runs are one task the user can open, steer or stop.
    const conversationId = await this.tasks.newTask(`Scheduled: ${row.name}`)
    row.conversation_id = conversationId
    await this.db.insertSchedule(row)
    const firstAt = Date.parse(row.next_at ?? '') || Date.now()
    const conversation = await this.runtime.require(conversationId)
    const taskId = await conversation.commit(
      (tx) =>
        tx.createTask(
          this.runtime.scheduleTask as never,
          { scheduleId: row.id, firstAt } as never,
          { ownership: { kind: 'conversation' }, background: true },
        ),
      CONTEXT,
    )
    row.task_id = String(taskId)
    await this.db.updateSchedule(row.id, { task_id: row.task_id })
    await this.tasks.refreshList()
    return viewOf(row)
  }

  async cancel(name: string): Promise<ScheduleView> {
    const row = await this.db.scheduleByName(name.trim())
    if (!row) throw new Error(`No schedule named "${name}".`)
    if (row.task_id)
      await this.runtime.pi.abortTask(row.task_id as never, CONTEXT).catch(() => undefined)
    await this.db.deleteSchedule(row.id)
    return viewOf(row)
  }

  /** pi's timer says a run is due: start it, and say when the next one is. */
  async fire(scheduleId: string, dueAt: number, _context: Context): Promise<number | null> {
    const row = await this.db.getSchedule(scheduleId)
    if (!row?.enabled || !row.conversation_id) return null
    const now = Date.now()
    let outcome = 'started'
    try {
      await this.engine.runScheduled(
        {
          id: row.id,
          name: row.name,
          prompt: row.prompt,
          conversationId: row.conversation_id,
          budgetTokens: row.budget_tokens ?? DEFAULT_BUDGET_TOKENS,
        },
        dueAt,
      )
    } catch (error) {
      // A run that cannot start (no model, a window too small) says so on its task and tries next time.
      outcome = error instanceof Error ? error.message.slice(0, 200) : 'failed'
    }
    const next = nextRun(row.cadence, now)
    await this.db.updateSchedule(row.id, {
      last_at: new Date(now).toISOString(),
      last_outcome: outcome,
      next_at: next === null ? null : new Date(next).toISOString(),
    })
    if (next === null) await this.db.deleteSchedule(row.id)
    return next
  }
}
