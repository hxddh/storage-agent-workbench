import { defineTool } from '@earendil-works/pi-durable'
import type { ToolDetails, ToolView } from '@shared/contract'
import { escapeTags, redact } from '../security/redact'
import type { ToolDeps } from './policy'
import { Type } from './policy'

/**
 * A child agent with the same read-only tools and scope, working in the same
 * task: its folder, attachments, datasets and task memory. The parent decides
 * when a question is independent enough to hand off; the child's steps show in
 * the delegate step while it works, and its answer — or the question it would
 * ask the user — comes back as the step's result.
 */
export function delegateTool(deps: ToolDeps) {
  return defineTool({
    name: 'delegate',
    description:
      "Give a self-contained investigation to a child agent and get its answer back. The child has the same read-only tools, account scope, memory and this task's attachments, results and datasets; it cannot write. Several delegate calls in one turn run at the same time. If the child needs something only the user can say, its question comes back to you to ask or to answer from what you know.",
    parameters: Type.Object({
      task: Type.String({ description: 'A complete, self-contained request for the child.' }),
      title: Type.Optional(Type.String({ description: 'A short label for the step.' })),
    }),
    execute: async (args, api, context) => {
      const started = Date.now()
      const task = args.task.trim()
      if (!task) throw new Error('delegate task is empty.')
      const own = String(api.conversationId)
      const root = await deps.db.rootConversation(own)
      const evidenceId = api.callId
        ? own === root
          ? String(api.callId)
          : `${own}.${String(api.callId)}`
        : undefined
      const title = args.title ?? 'Child agent'
      const target = redact(args.title ?? task.slice(0, 120))
      const callArgs = JSON.stringify({ task: redact(task) })
      const child = await api.commit(async (tx) => {
        const created = await tx.createConversation({
          ownership: { kind: 'task', taskId: api.taskId },
        } as never)
        return created.id
      }, context)
      const view = (
        status: Extract<ToolView, { kind: 'delegate' }>['status'],
        answer: string,
        calls: number,
      ): ToolView => ({
        kind: 'delegate',
        title,
        task: redact(task),
        conversationId: String(child),
        answer: redact(answer),
        status,
        calls,
      })
      // The window opens the child's conversation while it works, not only after.
      await Promise.resolve(
        api.details?.(
          {
            target,
            note: null,
            args: callArgs,
            view: view('running', '', 0),
            ms: null,
            status: 'running',
          } as never,
          context,
        ),
      ).catch(() => undefined)
      const conversation = await api.conversation(child, context)
      if (!conversation) throw new Error('The child conversation could not be opened.')
      const submission = await conversation.submit(
        {
          type: 'input',
          content: task,
          requestId: `delegate:${api.taskId}:${api.callId ?? Date.now()}`,
        },
        context,
      )
      // Stop is the user's control: stopping the parent stops the child too.
      const signal = (context as { abortSignal?: AbortSignal }).abortSignal
      const stopChild = () => void conversation.abort(context).catch(() => undefined)
      if (signal?.aborted) stopChild()
      signal?.addEventListener('abort', stopChild, { once: true })
      const settled = await submission
        .wait(context)
        .finally(() => signal?.removeEventListener('abort', stopChild))
      const entries = (await deps.entries?.(String(child))) ?? []
      const last = entries.at(-1)
      const calls = entries.filter((entry) => entry.kind === 'tool').length
      // A child that ended its turn on `ask` asked something only the user can answer.
      const question =
        last?.kind === 'tool' && last.name === 'ask' && last.view?.kind === 'question'
          ? last.view
          : null
      const answer = question
        ? ''
        : (entries.findLast((entry) => entry.kind === 'answer')?.text ?? '')
      const status = question
        ? 'asked'
        : settled.status === 'done'
          ? 'done'
          : settled.status === 'unanswered' && settled.reason === 'aborted'
            ? 'stopped'
            : 'failed'
      const note =
        status === 'asked'
          ? 'the child asked a question'
          : status === 'done'
            ? `${calls} call${calls === 1 ? '' : 's'}`
            : status === 'stopped'
              ? 'stopped'
              : settled.status === 'unanswered'
                ? settled.reason
                : 'failed'
      const details: ToolDetails = {
        target,
        note,
        args: callArgs,
        view: view(status, answer, calls),
        ms: Date.now() - started,
        status: status === 'asked' ? 'done' : status,
        ...(evidenceId ? { evidenceId } : {}),
      }
      await deps.db.audit({
        conversationId: root,
        tool: 'delegate',
        target,
        outcome:
          status === 'done' || status === 'asked'
            ? 'ok'
            : status === 'stopped'
              ? 'stopped'
              : 'error',
      })
      const said = question
        ? `The child agent asks: ${question.question}${
            question.options.length ? `\nOptions: ${question.options.join(' | ')}` : ''
          }${question.note ? `\n${question.note}` : ''}\nAsk the user, or delegate again with what you know.`
        : answer || '(no answer)'
      return {
        output: [
          {
            type: 'text' as const,
            text:
              status === 'done' || status === 'asked'
                ? `<untrusted-data source="delegate"${evidenceId ? ` evidence="${escapeTags(evidenceId).replaceAll('"', '&quot;')}"` : ''}>\n${escapeTags(redact(said))}\n</untrusted-data>`
                : `The child agent ${status}: ${note}`,
          },
        ],
        details: details as never,
      }
    },
  })
}
