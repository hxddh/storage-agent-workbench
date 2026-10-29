/**
 * One engine, two drivers.
 *
 * A model run is pi's durable loop: the model plans, calls tools and answers.
 * A scripted run (an account check, a re-check) calls the same registered tools
 * through the same `agentTool()` in a fixed order, leaves the same tool entries
 * and writes its answer from what they returned. Both settle the same way:
 * notices, the search index, reading records and the estate digest.
 */
import { randomUUID } from 'node:crypto'
import { configure } from '@earendil-works/pi-durable'
import type {
  AttachmentRef,
  ContextRef,
  Lang,
  LiveTool,
  NoticeCode,
  ReverifyChange,
  ReverifyReport,
  ToolDetails,
  ToolName,
  ToolView,
} from '@shared/contract'
import { foldLedger, type Ledger, readState } from '@shared/ledger'
import type { ReadingTrigger } from '../db'
import { ACCOUNT_SCOPE, aspectsOf, BY_CODE, ruleTitle } from '../estate/rules'
import { escapeTags } from '../security/redact'
import { maxRounds, runView } from './agent'
import {
  type Aspect,
  accessTargets,
  checkAnswer,
  RECHECK_BUCKETS,
  recheckAnswer,
  recheckTargets,
} from './check'
import { installModel } from './model'
import type { RunData } from './project'
import { comparePlanToReplay } from './reverify-plan'
import { CONTEXT, type RunOutcome, type Runtime } from './session'
import type { Tasks } from './tasks'

type SurveyView = Extract<ToolView, { kind: 'survey' }>
type Conversation = Awaited<ReturnType<Runtime['require']>>

interface ScriptedCall {
  details: ToolDetails
  /** What the model of a later run in this task sees: the bounded, enveloped output. */
  text: string
}

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
    if (this.runtime.scripted.has(taskId))
      throw new Error('A scripted check is running in this task; ask when it finishes.')
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
    const scripted = this.runtime.stops.get(taskId)
    if (scripted) {
      // A scripted run has nothing to continue; check again instead.
      scripted.abort()
      return
    }
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

  /** Resume a stopped run. The resume is a row in the run, not a new request. */
  async continueTask(taskId: string): Promise<void> {
    const conversation = await this.runtime.require(taskId)
    await this.run(
      conversation,
      'Continue from where you stopped. Do not repeat calls that already finished.',
      { kind: 'sa.resume' },
    )
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
    void this.settle(conversation, taskId, 'task', async () => {
      const settled = await submission.wait(CONTEXT)
      if (settled.status !== 'unanswered') return 'answered'
      if (settled.reason === 'aborted') return 'stopped'
      await this.notice(conversation, 'no_answer', 'error', 'retry', settled.reason)
      return 'failed'
    })
  }

  /** Every run, model or scripted, ends here. */
  private async settle(
    conversation: Conversation,
    taskId: string,
    trigger: ReadingTrigger,
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
        trigger === 'task' ? 'retry' : undefined,
        error instanceof Error ? error.message.slice(0, 200) : undefined,
      )
    } finally {
      this.runtime.scripted.delete(taskId)
      this.runtime.stops.delete(taskId)
      this.runtime.tools.accessSessions?.delete(taskId)
      this.deps.emit({ type: 'live', taskId, live: null })
      if (outcome === 'failed') this.runtime.failed.add(taskId)
      if (trigger === 'task') {
        const records = await this.runtime.records(taskId)
        const view = records ? runView(records) : null
        if (view && view.rounds > maxRounds(await this.runtime.tier(taskId)))
          await this.notice(conversation, 'budget', 'warn')
      }
      await this.deps.db.touchTask(taskId)
      await this.tasks.index(taskId).catch(() => undefined)
      if (outcome !== 'failed' && trigger !== 'reverify')
        await this.recordReadings(taskId, trigger).catch(() => undefined)
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

  // -- scripted runs --------------------------------------------------------------

  /** Call one registered tool as a scripted step and record it like a model's call. */
  private async call(
    conversation: Conversation,
    taskId: string,
    name: ToolName,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ScriptedCall> {
    const tool = this.runtime.registry.find((item) => item.name === name)
    if (!tool) throw new Error(`No tool named ${name}.`)
    const callId = `chk_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const startedAt = new Date().toISOString()
    const slot: LiveTool = {
      callId,
      name,
      target: '',
      note: null,
      status: 'running',
      startedAt,
    }
    const show = () => {
      const live = this.runtime.scripted.get(taskId)
      if (!live) return
      live.tools = [...live.tools.filter((item) => item.callId !== callId), { ...slot }]
      this.deps.emit({ type: 'live', taskId, live: { ...live } })
    }
    show()
    const result = await tool.execute(
      args as never,
      {
        conversationId: taskId,
        callId,
        output: () => undefined,
        details: async (value: ToolDetails) => {
          slot.target = value.target
          slot.note = value.progress ?? value.note
          slot.args = value.args ?? null
          show()
        },
      } as never,
      { conversationId: taskId, abortSignal: signal } as never,
    )
    const details = result.details as unknown as ToolDetails
    const text = (result.output ?? [])
      .map((part: { type: string; text?: string }) =>
        part.type === 'text' ? (part.text ?? '') : '',
      )
      .join('\n')
    await this.runtime.write(conversation, 'sa.call', { name, at: startedAt, details })
    const live = this.runtime.scripted.get(taskId)
    if (live) live.tools = live.tools.filter((item) => item.callId !== callId)
    return { details, text }
  }

  /** Start a scripted run: a boundary entry, a live slot and a stop. */
  private async begin(
    conversation: Conversation,
    taskId: string,
    trigger: 'check' | 'recheck',
    timeoutMs: number,
  ): Promise<AbortSignal> {
    const at = new Date().toISOString()
    const stop = new AbortController()
    this.runtime.stops.set(taskId, stop)
    this.runtime.scripted.set(taskId, {
      phase: 'tool',
      tools: [],
      reasoning: null,
      text: null,
      startedAt: at,
    })
    await this.runtime.write(conversation, 'sa.run', { trigger, at })
    this.tasks.emitTask(taskId)
    return AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)])
  }

  /** A stopped scripted run ends with what it read; the rest stays unread. */
  private stopped(signal: AbortSignal, conversation: Conversation): Promise<RunOutcome> | null {
    if (!signal.aborted) return null
    return this.notice(conversation, 'stopped', 'info').then(() => 'stopped' as const)
  }

  /** The scripted answer: shown as the run's answer, and the context a later model run reads. */
  private async answer(
    conversation: Conversation,
    text: string,
    calls: readonly ScriptedCall[],
    heading: string,
  ): Promise<void> {
    const at = new Date().toISOString()
    const context = [
      `[${heading} — a scripted run of the read-only tools; no model took part.]`,
      ...calls.map((call) => call.text),
      `Summary written from those results:\n<untrusted-data source="check">\n${escapeTags(text)}\n</untrusted-data>`,
    ].join('\n\n')
    await this.runtime.write(conversation, 'sa.answer', { text, at }, [
      { role: 'user', content: context, timestamp: Date.now() },
    ])
  }

  /** A model-free account check: survey every account, then access for up to 24 buckets each. */
  async check(taskId: string, providerIds?: string[]): Promise<RunOutcome> {
    const conversation = await this.runtime.require(taskId)
    const all = await this.deps.providers.list()
    const accounts = providerIds ? all.filter((item) => providerIds.includes(item.id)) : all
    if (!accounts.length) throw new Error('Add a storage account first.')
    if (await this.tasks.busy(taskId)) throw new Error('This task is still running.')
    const lang = this.deps.settings.get().language as Lang
    const signal = await this.begin(conversation, taskId, 'check', 600_000)
    return this.settle(conversation, taskId, 'check', async () => {
      const calls: ScriptedCall[] = []
      const surveys: { view: SurveyView; evidenceId?: string }[] = []
      const access = { examined: 0, total: 0 }
      let failed = 0
      for (const account of accounts) {
        if (signal.aborted) break
        const survey = await this.call(
          conversation,
          taskId,
          'survey',
          { provider_id: account.id },
          signal,
        )
        calls.push(survey)
        const view = survey.details.view?.kind === 'survey' ? survey.details.view : null
        if (!view) {
          failed += 1
          continue
        }
        surveys.push({ view, evidenceId: survey.details.evidenceId })
        access.total += view.coverage.visible
        for (const bucket of accessTargets(view)) {
          if (signal.aborted) break
          const read = await this.call(
            conversation,
            taskId,
            'config',
            { provider_id: account.id, bucket, aspect: 'access' },
            signal,
          )
          calls.push(read)
          if (read.details.status === 'done') access.examined += 1
        }
      }
      const stopped = this.stopped(signal, conversation)
      if (stopped) return stopped
      await this.answer(
        conversation,
        checkAnswer(surveys, access, failed, lang),
        calls,
        'Account check',
      )
      return 'answered'
    })
  }

  /**
   * Re-read what the task read, as a scripted run in the same task. It replays
   * the reads, not the prose, and compares every remembered conclusion and
   * every change-plan step with what the fresh reads decided.
   */
  async recheck(taskId: string): Promise<void> {
    const conversation = await this.runtime.require(taskId)
    if (await this.tasks.busy(taskId)) throw new Error('This task is still running.')
    const targets = recheckTargets(await this.runtime.entries(taskId))
    if (!targets.accounts.size) throw new Error('This task has no storage reading to re-check.')
    const lang = this.deps.settings.get().language as Lang
    const signal = await this.begin(conversation, taskId, 'recheck', 300_000)
    await this.settle(conversation, taskId, 'reverify', async () => {
      const calls: ScriptedCall[] = []
      const replay = new Map<
        string,
        { visible: number; checked: number; unknown: number; truncated: boolean }
      >()
      const changes: ReverifyChange[] = []
      const after = new Map<string, ReverifyChange['after']>()
      const checked = new Set<string>()
      let skipped = 0
      let truncated = false
      let opened = 0
      let resolved = 0
      let undecided = 0
      for (const [providerId, buckets] of targets.accounts) {
        if (signal.aborted) break
        const config = await this.deps.providers.config(providerId).catch(() => null)
        const list = [...buckets.entries()]
        if (!config) {
          skipped += list.length
          continue
        }
        if (list.length > RECHECK_BUCKETS) {
          truncated = true
          skipped += list.length - RECHECK_BUCKETS
        }
        const chosen = list
          .slice(0, RECHECK_BUCKETS)
          .filter(
            ([bucket]) => !config.scope.buckets.length || config.scope.buckets.includes(bucket),
          )
        skipped += Math.min(list.length, RECHECK_BUCKETS) - chosen.length
        // What the estate concluded before the fresh reads, per bucket and rule.
        const codes = new Map<string, string[]>()
        for (const [bucket, aspects] of chosen)
          codes.set(
            bucket,
            [...aspects].flatMap((aspect) => (aspect === 'access' ? [] : aspectsOf(aspect))),
          )
        if (this.deps.providers.isAws(config))
          codes.set(ACCOUNT_SCOPE, ['account_public_access_block_missing'])
        const before = new Map<string, 'open' | 'accepted' | 'clear'>()
        for (const [bucket, list] of codes)
          for (const code of list) {
            const issue = await this.deps.db.findIssue(providerId, bucket, code)
            before.set(
              `${bucket}|${code}`,
              issue?.status === 'open'
                ? 'open'
                : issue?.status === 'accepted'
                  ? 'accepted'
                  : 'clear',
            )
          }
        const blind = new Set<string>()
        const survey = await this.call(
          conversation,
          taskId,
          'survey',
          { provider_id: providerId, buckets: chosen.map(([bucket]) => bucket) },
          signal,
        )
        calls.push(survey)
        const view = survey.details.view?.kind === 'survey' ? survey.details.view : null
        opened += survey.details.assessed?.opened ?? 0
        resolved += survey.details.assessed?.resolved ?? 0
        for (const row of view?.buckets.rows ?? []) checked.add(`${providerId}|${String(row[0])}`)
        if (view?.accountRead) checked.add(`${providerId}|`)
        for (const item of view?.undecided ?? []) blind.add(`${item.bucket}|${item.code}`)
        for (const [bucket, aspects] of chosen)
          for (const aspect of ['observability', 'access'] as Aspect[]) {
            if (!aspects.has(aspect) || signal.aborted) continue
            const read = await this.call(
              conversation,
              taskId,
              'config',
              { provider_id: providerId, bucket, aspect },
              signal,
            )
            calls.push(read)
            opened += read.details.assessed?.opened ?? 0
            resolved += read.details.assessed?.resolved ?? 0
            if (read.details.status === 'done') checked.add(`${providerId}|${bucket}`)
            if (read.details.view?.kind === 'config')
              for (const finding of read.details.view.findings)
                if (finding.severity === 'blind' && finding.code)
                  blind.add(`${bucket}|${finding.code}`)
          }
        const missed = chosen.filter(([bucket]) => !checked.has(`${providerId}|${bucket}`)).length
        skipped += missed
        replay.set(providerId, {
          visible: list.length,
          checked: chosen.length - missed,
          unknown: [...blind].length,
          truncated: list.length > RECHECK_BUCKETS,
        })
        for (const [bucket, list] of codes) {
          if (!checked.has(`${providerId}|${bucket}`)) continue
          for (const code of list) {
            const issue = await this.deps.db.findIssue(providerId, bucket, code)
            const now: ReverifyChange['after'] = blind.has(`${bucket}|${code}`)
              ? 'undecided'
              : issue?.status === 'open'
                ? 'open'
                : issue?.status === 'accepted'
                  ? 'accepted'
                  : 'clear'
            after.set(`${providerId}|${bucket}|${code}`, now)
            if (now === 'undecided') undecided += 1
            const previous = before.get(`${bucket}|${code}`) ?? 'clear'
            const rule = BY_CODE.get(code)
            if (rule && previous !== now)
              changes.push({
                bucket,
                code,
                title: ruleTitle(rule, lang),
                before: previous,
                after: now,
              })
          }
        }
      }
      const stopped = this.stopped(signal, conversation)
      if (stopped) return stopped
      const plan =
        targets.plan && targets.planProviderId
          ? comparePlanToReplay(
              targets.plan,
              (bucket) => checked.has(`${targets.planProviderId}|${bucket}`),
              (bucket, code) => after.get(`${targets.planProviderId}|${bucket}|${code}`),
            )
          : undefined
      const report: ReverifyReport = {
        at: new Date().toISOString(),
        checked: [...checked].filter((key) => !key.endsWith('|')).length,
        skipped,
        ...(truncated ? { truncated } : {}),
        changes,
        opened,
        resolved,
        undecided,
        ...(plan ? { plan } : {}),
      }
      await this.runtime.write(conversation, 'sa.reverify', report)
      // A re-check is always partial: it proves its buckets, never the account.
      for (const [providerId, item] of replay)
        await this.deps.db
          .insertReading({
            conversationId: taskId,
            providerId,
            at: report.at,
            trigger: 'reverify',
            complete: false,
            visible: item.visible,
            processed: item.checked,
            pending: item.visible - item.checked,
            denied: 0,
            unknown: item.unknown,
            truncated: item.truncated ? 1 : 0,
            openHigh: await this.deps.db.countOpenHigh(providerId),
            openTotal: await this.deps.db.countOpenIssues(providerId),
          })
          .catch(() => undefined)
      await this.answer(
        conversation,
        recheckAnswer(report, calls[0]?.details.evidenceId, lang),
        calls,
        'Re-check',
      )
      return 'answered'
    })
  }

  /**
   * One reading row per account the run surveyed account-wide. It stores
   * counts, never request text, prose, policy or an account id. A re-check is
   * always partial.
   */
  private async recordReadings(taskId: string, trigger: ReadingTrigger): Promise<void> {
    const ledger: Ledger = foldLedger(await this.runtime.entries(taskId))
    for (const coverage of ledger.coverage) {
      const providerId = coverage.providerId
      if (!providerId) continue
      const state = readState(ledger, providerId)
      await this.deps.db.insertReading({
        conversationId: taskId,
        providerId,
        at: coverage.at || new Date().toISOString(),
        trigger,
        complete: trigger !== 'reverify' && state.complete,
        visible: state.visible,
        processed: state.processed,
        pending: state.pending,
        denied: state.denied,
        unknown: state.unknown,
        truncated: state.truncated,
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
