/**
 * Turns of the conversation.
 *
 * Every turn is pi's durable loop: the user writes, the model reads with its
 * tools and answers. This installs the task's model, submits the message, and
 * settles the turn: notices, the search index, reading records and the estate
 * digest. There is no second driver and no scripted run.
 */
import { configure } from '@earendil-works/pi-durable'
import type { AttachmentRef, ContextRef, NoticeCode } from '@shared/contract'
import { escapeTags } from '../security/redact'
import { maxRounds, runView } from './agent'
import { installModel } from './model'
import type { RunData } from './project'
import { turnSurveys } from './readings'
import { CONTEXT, type RunOutcome, type Runtime } from './session'
import type { Tasks } from './tasks'

type Conversation = Awaited<ReturnType<Runtime['require']>>

export class Engine {
  constructor(
    private readonly runtime: Runtime,
    private readonly tasks: Tasks,
  ) {}

  private get deps() {
    return this.runtime.deps
  }

  hasModel(): boolean {
    return Boolean(this.deps.settings.get().model)
  }

  // -- model runs ---------------------------------------------------------------

  async submit(
    taskId: string,
    text: string,
    attachments: AttachmentRef[],
    context: ContextRef[] = [],
  ): Promise<void> {
    const conversation = await this.runtime.require(taskId)
    const focus = await this.tasks.sanitizeContext(context)
    await this.deps.db.touchTask(taskId)
    const data: RunData = {
      trigger: 'user',
      text,
      attachments,
      ...(focus.length ? { context: focus } : {}),
    }
    await this.run(conversation, withAttachments(text, attachments, focus), {
      kind: 'sa.run',
      data,
    })
  }

  /** A steer joins a running run. With no run going, it is a new request. */
  async steer(
    taskId: string,
    text: string,
    attachments: AttachmentRef[] = [],
    context: ContextRef[] = [],
  ): Promise<void> {
    if (!(await this.tasks.busy(taskId))) return this.submit(taskId, text, attachments, context)
    const conversation = await this.runtime.require(taskId)
    const focus = await this.tasks.sanitizeContext(context)
    const submission = await conversation.submit(
      {
        type: 'input',
        content: withAttachments(text, attachments, focus),
        whenBusy: 'steer',
        entry: {
          kind: 'sa.steer',
          data: { text, attachments, ...(focus.length ? { context: focus } : {}) },
        } as never,
      },
      CONTEXT,
    )
    // The running submission's settlement does the bookkeeping.
    void submission.wait(CONTEXT).catch(() => undefined)
  }

  async stop(taskId: string): Promise<void> {
    const conversation = await this.runtime.conversation(taskId)
    if (!conversation) return
    await conversation.abort(CONTEXT)
    await this.notice(conversation, 'stopped', 'info', 'continue')
  }

  /** Ask the run's request again, with the files and focus it carried. A steer is not a request. */
  async retry(taskId: string): Promise<void> {
    const entries = await this.runtime.entries(taskId)
    const last = entries.findLast((entry) => entry.kind === 'user')
    if (last?.kind !== 'user') throw new Error('There is nothing to retry.')
    await this.submit(taskId, last.text, last.attachments, last.context ?? [])
  }

  /**
   * Resume a stopped turn. The user's Continue is the whole message; the
   * window shows it as the divider, and the agent decides what to do next.
   */
  async continueTask(taskId: string): Promise<void> {
    const conversation = await this.runtime.require(taskId)
    await this.run(conversation, 'Continue.', { kind: 'sa.resume' })
  }

  private async run(
    conversation: Conversation,
    content: string,
    entry: { kind: string; data?: unknown },
  ): Promise<void> {
    const taskId = String(conversation.id)
    const stored = this.deps.settings.get().model
    if (!stored) throw new Error('Choose a model in Settings first.')
    const chosen = await this.runtime.taskModel(taskId)
    if (chosen && chosen.provider !== stored.provider && !chosen.baseUrl)
      throw new Error('This task model needs a base URL.')
    // The model is installed for this run only; a task's choice never leaks into another task.
    const model = installModel(
      this.deps.models,
      chosen
        ? {
            ...stored,
            provider: chosen.provider,
            modelId: chosen.modelId,
            baseUrl: chosen.baseUrl ?? stored.baseUrl,
            thinking: chosen.thinking,
            ...(chosen.provider !== stored.provider ? { keyRef: '' } : {}),
          }
        : stored,
      this.deps.vault,
    )
    await this.runtime.pi.commit(
      (tx) =>
        configure(tx, conversation.id, {
          model,
          thinkingLevel: chosen?.thinking ?? stored.thinking ?? 'off',
        }),
      CONTEXT,
    )
    this.runtime.failed.delete(taskId)
    const submission = await conversation.submit(
      { type: 'input', content, entry: entry as never },
      CONTEXT,
    )
    void this.settle(conversation, taskId, async () => {
      const settled = await submission.wait(CONTEXT)
      if (settled.status !== 'unanswered') return 'answered'
      if (settled.reason === 'aborted') return 'stopped'
      await this.notice(conversation, 'no_answer', 'error', 'retry', settled.reason)
      return 'failed'
    })
  }

  /** Every turn ends here. */
  private async settle(
    conversation: Conversation,
    taskId: string,
    work: () => Promise<RunOutcome>,
  ): Promise<RunOutcome> {
    let outcome: RunOutcome = 'answered'
    try {
      outcome = await work()
    } catch (error) {
      outcome = 'failed'
      await this.notice(
        conversation,
        'failed',
        'error',
        'retry',
        error instanceof Error ? error.message.slice(0, 200) : undefined,
      )
    } finally {
      this.runtime.tools.accessSessions?.delete(taskId)
      if (outcome === 'failed') this.runtime.failed.add(taskId)
      const records = await this.runtime.records(taskId)
      const view = records ? runView(records) : null
      if (view && view.rounds > maxRounds(await this.runtime.tier(taskId)))
        await this.notice(conversation, 'budget', 'warn')
      await this.deps.db.touchTask(taskId)
      await this.tasks.index(taskId).catch(() => undefined)
      if (outcome !== 'failed') await this.recordReadings(taskId).catch(() => undefined)
      await this.runtime.refreshDigest()
      await this.tasks.refreshList()
      const summary = await this.tasks.summary(taskId)
      if (summary) this.deps.settled?.(summary, outcome)
    }
    return outcome
  }

  private async notice(
    conversation: Conversation,
    code: NoticeCode,
    tone: 'info' | 'warn' | 'error',
    action?: 'retry' | 'continue',
    detail?: string,
  ): Promise<void> {
    await this.runtime
      .write(conversation, 'sa.notice', {
        code,
        text: detail ?? '',
        tone,
        ...(action ? { action } : {}),
      })
      .catch(() => undefined)
  }

  /** One reading row per account the turn surveyed account-wide: counts only. */
  private async recordReadings(taskId: string): Promise<void> {
    for (const survey of turnSurveys(await this.runtime.entries(taskId))) {
      const { providerId, at, ...counts } = survey
      await this.deps.db.insertReading({
        conversationId: taskId,
        providerId,
        at: at || new Date().toISOString(),
        trigger: 'task',
        ...counts,
        openHigh: await this.deps.db.countOpenHigh(providerId),
        openTotal: await this.deps.db.countOpenIssues(providerId),
      })
    }
  }
}

function withAttachments(
  text: string,
  attachments: readonly AttachmentRef[],
  context: readonly ContextRef[] = [],
): string {
  const parts = [text]
  if (attachments.length)
    parts.push(`[attached files: ${attachments.map((file) => file.name).join(', ')}]`)
  if (context.length)
    parts.push(
      `<untrusted-data source="user-context">\n[Focused names; focus only, not authorization]\n${escapeTags(
        context
          .map(
            (item) =>
              `${item.kind}: ${item.label}${item.bucket && item.kind !== 'account' ? ` (${item.bucket})` : ''}`,
          )
          .join('\n'),
      )}\n</untrusted-data>`,
    )
  return parts.join('\n\n')
}
