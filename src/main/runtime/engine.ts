/**
 * Turns of the conversation.
 *
 * Every turn is pi's durable loop: the user writes, the model reads with its
 * tools and answers. This installs the task's model, submits the message, and
 * settles the turn: notices, the search index and the memory digest. There is
 * no second driver and no scripted run.
 */
import { ConversationIdle, configure } from '@earendil-works/pi-durable'
import type { AttachmentRef, ContextRef, NoticeCode, TaskModel } from '@shared/contract'
import { isLoopback, LOCAL_DEFAULT_CONTEXT } from '../local-models'
import { contextFor } from '../model-catalog'
import { wrapUntrusted } from '../security/redact'
import type { StoredModel } from '../settings'
import { compactionFor, installModel, learnOutputLimit, outputCap, windowRefusal } from './model'
import type { RunData } from './project'
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
    const conversation = await this.runtime.require(taskId)
    const focus = await this.tasks.sanitizeContext(context)
    try {
      // One admission: busy steers, idle says so. No check-then-act window.
      const submission = await conversation.submit(
        {
          type: 'input',
          content: withAttachments(text, attachments, focus),
          whenBusy: 'steer',
          whenIdle: 'reject',
          entry: {
            kind: 'sa.steer',
            data: { text, attachments, ...(focus.length ? { context: focus } : {}) },
          } as never,
        },
        CONTEXT,
      )
      // The running submission's settlement does the bookkeeping.
      void submission.wait(CONTEXT).catch(() => undefined)
    } catch (error) {
      if (!(error instanceof ConversationIdle)) throw error
      await this.submit(taskId, text, attachments, context)
    }
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

  /**
   * One run of a schedule: the schedule's prompt as a turn in its own task.
   * Nobody is watching, so the run stops at its token budget — unless the user
   * opens the task while it works, which makes it attended.
   */
  async runScheduled(
    schedule: {
      id: string
      name: string
      prompt: string
      conversationId: string
      budgetTokens: number
    },
    dueAt: number,
  ): Promise<void> {
    const conversation = await this.runtime.require(schedule.conversationId)
    await this.deps.db.touchTask(schedule.conversationId)
    await this.run(
      conversation,
      `[Scheduled run of "${schedule.name}", due ${new Date(dueAt).toISOString()}. Nobody is watching: use notify to tell the user what they need to know.]\n\n${schedule.prompt}`,
      {
        kind: 'sa.run',
        data: { text: schedule.prompt, attachments: [], scheduled: schedule.name },
      },
      { requestId: `schedule:${schedule.id}:${dueAt}`, budgetTokens: schedule.budgetTokens },
    )
  }

  private async run(
    conversation: Conversation,
    content: string,
    entry: { kind: string; data?: unknown },
    options: { requestId?: string; budgetTokens?: number } = {},
  ): Promise<void> {
    const taskId = String(conversation.id)
    const stored = this.deps.settings.get().model
    if (!stored) throw new Error('Choose a model in Settings first.')
    const chosen = await this.runtime.taskModel(taskId)
    // The model is installed for this run only; a task's choice never leaks into another task.
    const { model: effective, directKey } = resolveTaskModel(stored, chosen, (ref) =>
      this.deps.settings.saved(ref),
    )
    const tooSmall = windowRefusal(effective)
    if (tooSmall) throw new Error(tooSmall)
    this.runtime.windows.set(taskId, effective.contextWindow)
    const vault = directKey === undefined ? this.deps.vault : null
    const limit = outputCap(
      effective.contextWindow,
      await learnOutputLimit(this.deps.models, effective, vault, directKey),
    )
    const model = installModel(this.deps.models, effective, vault, directKey, undefined, limit)
    await this.runtime.pi.commit(
      (tx) =>
        configure(tx, conversation.id, {
          model,
          thinkingLevel: chosen?.thinking ?? stored.thinking ?? 'off',
          // Delegated children inherit it with the rest of the agent.
          compaction: compactionFor(effective.contextWindow),
        }),
      CONTEXT,
    )
    this.runtime.failed.delete(taskId)
    const before = options.budgetTokens ? await this.tasks.spentTokens(taskId) : 0
    const submission = await conversation.submit(
      {
        type: 'input',
        content,
        entry: entry as never,
        ...(options.requestId ? { requestId: options.requestId } : {}),
      },
      CONTEXT,
    )
    // An unattended run stops at its budget; a run the user is watching has none.
    let overBudget = false
    const budget = options.budgetTokens
    const monitor = budget
      ? setInterval(() => {
          if (this.tasks.isWatched(taskId)) return
          void this.tasks.spentTokens(taskId).then((spent) => {
            if (spent - before <= budget || overBudget) return
            overBudget = true
            void conversation.abort(CONTEXT).catch(() => undefined)
          })
        }, 3_000)
      : null
    void this.settle(conversation, taskId, async () => {
      const settled = await submission.wait(CONTEXT).finally(() => {
        if (monitor) clearInterval(monitor)
      })
      if (settled.status !== 'unanswered') return 'answered'
      if (settled.reason === 'aborted' && overBudget) {
        await this.notice(conversation, 'budget', 'warn', 'continue')
        return 'stopped'
      }
      if (settled.reason === 'aborted') return 'stopped'
      await this.notice(conversation, 'no_answer', 'error', 'retry', reasonText(settled.reason))
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
      if (outcome === 'failed') this.runtime.failed.add(taskId)
      await this.deps.db.touchTask(taskId)
      if (outcome !== 'answered') await this.tasks.index(taskId).catch(() => undefined)
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
}

/**
 * The model a task runs with and the key it uses. A task's own choice runs
 * with the configuration saved for that model in Settings — its key, its
 * window; a model on this machine needs no key; any other model of the
 * default's provider uses the default's key. Nothing else is guessed.
 */
export function resolveTaskModel(
  stored: StoredModel,
  chosen: TaskModel | null,
  saved: (ref: TaskModel) => StoredModel | null,
): { model: StoredModel; directKey?: string } {
  if (!chosen) return { model: stored }
  const config = saved(chosen)
  if (config) return { model: { ...config, thinking: chosen.thinking } }
  const base = {
    provider: chosen.provider,
    modelId: chosen.modelId,
    baseUrl: chosen.baseUrl ?? '',
    thinking: chosen.thinking,
  }
  if (isLoopback(chosen.baseUrl))
    return {
      model: { ...base, contextWindow: chosen.contextWindow ?? LOCAL_DEFAULT_CONTEXT, keyRef: '' },
      directKey: 'local',
    }
  if (chosen.provider === stored.provider && (chosen.baseUrl ?? '') === (stored.baseUrl || ''))
    return { model: { ...base, contextWindow: contextFor(chosen.modelId), keyRef: stored.keyRef } }
  throw new Error(
    `${chosen.modelId} has no saved key. Save it in Settings → Model once; then any task can use it.`,
  )
}

/** pi's run-failure reason as the one line the notice shows. */
function reasonText(reason: string): string {
  const words: Record<string, string> = {
    model_error: 'The model returned an error.',
    no_model: 'No model is available.',
    reset: 'The run was reset before it answered.',
    faulted: 'The run failed.',
    orphaned: 'The run could not continue.',
    interrupted: 'The app was interrupted before the model answered.',
    restart_limit: 'The app was interrupted too many times.',
    nothing_to_answer: 'There was nothing to answer.',
    turn_limit: 'The turn limit was reached.',
  }
  return words[reason] ?? 'The run ended without an answer.'
}

function withAttachments(
  text: string,
  attachments: readonly AttachmentRef[],
  context: readonly ContextRef[] = [],
): string {
  const parts = [text]
  // Each file by the name the tools read it by: `more` reads any stretch of it
  // (an image is shown), `query`'s dataset() imports it whole.
  if (attachments.length)
    parts.push(
      `[attached files: ${attachments
        .map((file) => `attachment:${file.name} (${file.bytes.toLocaleString('en-US')} bytes)`)
        .join(', ')}]`,
    )
  if (context.length)
    parts.push(
      wrapUntrusted(
        'user-context',
        `[Focused names; focus only, not authorization]\n${context
          .map(
            (item) =>
              `${item.kind}: ${item.label}${item.bucket && item.kind !== 'account' ? ` (${item.bucket})` : ''}`,
          )
          .join('\n')}`,
      ),
    )
  return parts.join('\n\n')
}
