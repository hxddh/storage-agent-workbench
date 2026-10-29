import { defineTool } from '@earendil-works/pi-durable'
import type { ToolDetails } from '@shared/contract'
import { escapeTags, redact } from '../security/redact'
import type { ToolDeps } from './policy'
import { Type } from './policy'

/**
 * A child agent with the same read-only tools and scope. The parent decides
 * when a question is independent enough to hand off; the child's answer comes
 * back as the delegate step's result.
 */
export function delegateTool(deps: ToolDeps) {
  return defineTool({
    name: 'delegate',
    description:
      'Give a self-contained investigation to a child agent and get its answer back. The child inherits the read-only tools, account scope and memory; it cannot write. Use it when independent accounts, buckets or questions can be explored in parallel.',
    parameters: Type.Object({
      task: Type.String({ description: 'A complete, self-contained request for the child.' }),
      title: Type.Optional(Type.String({ description: 'A short label for the step.' })),
    }),
    execute: async (args, api, context) => {
      const started = Date.now()
      const task = args.task.trim()
      if (!task) throw new Error('delegate task is empty.')
      const child = await api.commit(async (tx) => {
        const created = await tx.createConversation({
          ownership: { kind: 'task', taskId: api.taskId },
        } as never)
        return created.id
      }, context)
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
      const answer = entries.findLast((entry) => entry.kind === 'answer')?.text ?? ''
      const calls = entries.filter((entry) => entry.kind === 'tool').length
      const status =
        settled.status === 'done'
          ? 'done'
          : settled.status === 'unanswered' && settled.reason === 'aborted'
            ? 'stopped'
            : 'failed'
      const note =
        status === 'done'
          ? `${calls} call${calls === 1 ? '' : 's'}`
          : status === 'stopped'
            ? 'stopped'
            : settled.status === 'unanswered'
              ? settled.reason.slice(0, 120)
              : 'failed'
      const details: ToolDetails = {
        target: redact(args.title ?? task.slice(0, 120)),
        note,
        args: JSON.stringify({ task: redact(task).slice(0, 400) }),
        view: {
          kind: 'delegate',
          title: args.title ?? 'Child agent',
          task: redact(task),
          conversationId: String(child),
          answer: redact(answer),
          status,
          calls,
        },
        ms: Date.now() - started,
        status,
        ...(api.callId ? { evidenceId: String(api.callId) } : {}),
      }
      await deps.db.audit({
        conversationId: String(api.conversationId),
        tool: 'delegate',
        target: details.target,
        outcome: status === 'done' ? 'ok' : status === 'stopped' ? 'stopped' : 'error',
      })
      return {
        output: [
          {
            type: 'text' as const,
            text:
              status === 'done'
                ? `<untrusted-data source="delegate">\n${escapeTags(redact(answer || '(no answer)'))}\n</untrusted-data>`
                : `The child agent ${status}: ${note}`,
          },
        ],
        details: details as never,
      }
    },
  })
}
