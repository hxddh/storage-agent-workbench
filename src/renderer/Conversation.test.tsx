// @vitest-environment jsdom
import type { TaskView, UiEntry } from '@shared/contract'
import { buckets } from '@shared/testing'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conversation } from './Conversation'

function view(entries: UiEntry[], extra: Partial<TaskView> = {}): TaskView {
  return {
    task: { id: 't', title: 'Task', state: 'ready', createdAt: '', updatedAt: '', pinned: false },
    entries,
    live: null,
    hasOlder: false,
    cursor: null,
    usage: null,
    ...extra,
  }
}

const user = (id: string, text: string): UiEntry => ({
  id,
  kind: 'user',
  at: '2026-01-01T00:00:00Z',
  text,
  attachments: [],
})

const call: UiEntry = {
  id: 'call-entry',
  kind: 'tool',
  at: '2026-01-01T00:00:01Z',
  name: 'buckets',
  target: 'Prod',
  status: 'done',
  note: '1 bucket',
  ms: 1200,
  view: buckets(['logs']),
  callId: 'ev1',
  evidenceId: 'ev1',
}

const text = (id: string, value: string): UiEntry => ({
  id,
  kind: 'answer',
  at: '2026-01-01T00:00:02Z',
  text: value,
})

const props = {
  lang: 'en' as const,
  focusId: null,
  onRetry: () => undefined,
  onContinue: () => undefined,
  onAnswer: () => undefined,
}

beforeEach(() => {
  Object.defineProperty(window, 'agent', {
    configurable: true,
    value: { saveText: vi.fn() },
  })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => cleanup())

describe('the conversation', () => {
  it('reads as messages with the calls inline, and no report scaffolding', async () => {
    render(
      <Conversation
        {...props}
        view={view([
          user('u1', 'Which buckets are public?'),
          call,
          text('a1', '`logs` is private.'),
          user('u2', 'Thanks — what about access?'),
          text('a2', 'Nothing grants public access.'),
        ])}
      />,
    )
    expect(screen.getByText('Which buckets are public?')).toBeTruthy()
    expect(screen.getByText('Thanks — what about access?')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Nothing grants public access.')).toBeTruthy())
    expect(document.querySelectorAll('.msg.user')).toHaveLength(2)
    expect(document.querySelectorAll('.step.tool')).toHaveLength(1)
    for (const gone of ['Earlier in this task', 'Not checked', 'Findings', 'Work'])
      expect(screen.queryByText(gone)).toBeNull()
  })

  it('opens a call in place, and a citation opens the call it names', async () => {
    render(
      <Conversation
        {...props}
        view={view([user('u1', 'Q'), call, text('a1', '`logs` is private [1](#ev-ev1).')])}
      />,
    )
    expect(document.querySelector('.step-detail')).toBeNull()
    await waitFor(() => expect(document.querySelector('.cite')).toBeTruthy())
    fireEvent.click(document.querySelector('.cite')!)
    await waitFor(() => expect(document.querySelector('.step-detail')).toBeTruthy())
  })

  it('does not offer a link to a call the conversation does not hold', async () => {
    render(
      <Conversation
        {...props}
        view={view([user('u1', 'Q'), call, text('a1', 'Read [1](#ev-ev1), not [2](#ev-gone).')])}
      />,
    )
    await waitFor(() => expect(document.querySelectorAll('.cite')).toHaveLength(2))
    expect(document.querySelectorAll('button.cite')).toHaveLength(1)
    expect(document.querySelector('sup.cite.missing')?.getAttribute('title')).toMatch(/No call/)
  })

  it('answers a clarifying question with one click while the agent waits', () => {
    const onAnswer = vi.fn()
    render(
      <Conversation
        {...props}
        onAnswer={onAnswer}
        view={view([
          user('u1', 'Clarify'),
          {
            id: 'q',
            kind: 'tool',
            at: '',
            name: 'ask',
            target: 'clarify',
            status: 'done',
            note: null,
            ms: 0,
            view: { kind: 'question', question: 'Which account?', options: ['Prod', 'Staging'] },
          },
        ])}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Prod' }))
    expect(onAnswer).toHaveBeenCalledWith('Prod')
  })

  it('shows a configuration read section by section, as S3 returned it', async () => {
    render(
      <Conversation
        {...props}
        view={view([
          user('u1', 'Is logs public?'),
          {
            id: 'cfg',
            kind: 'tool',
            at: '',
            name: 'config',
            target: 'logs',
            status: 'done',
            note: '1 available · 1 access denied',
            ms: 10,
            view: {
              kind: 'raw',
              title: 'logs',
              value: {
                region: 'us-east-1',
                policy: { status: 'available', value: { Statement: [{ Principal: '*' }] } },
                acl: { status: 'access_denied', error: 'AccessDenied: denied' },
              },
            },
          },
        ])}
      />,
    )
    fireEvent.click(document.querySelector('.step-line')!)
    await waitFor(() => expect(document.querySelector('.raw-sections')).toBeTruthy())
    expect(screen.getByText('access denied')).toBeTruthy()
    expect(screen.getByText('AccessDenied: denied')).toBeTruthy()
    expect(document.querySelector('.raw-section pre')?.textContent).toContain('"Principal": "*"')
  })

  it('shows a call from an earlier version as a step with what the agent received', async () => {
    render(
      <Conversation
        {...props}
        view={view([
          user('u1', 'Accept it'),
          {
            id: 'acc',
            kind: 'tool',
            at: '',
            name: 'accept_risk',
            target: 'logs',
            status: 'done',
            note: null,
            ms: 0,
            view: null,
            output: '<untrusted-data>Asked the user.</untrusted-data>',
          },
        ])}
      />,
    )
    expect(screen.getByText('Asked to accept a risk')).toBeTruthy()
    fireEvent.click(document.querySelector('.step-line')!)
    await waitFor(() => expect(screen.getByText(/Asked the user\./)).toBeTruthy())
    expect(document.querySelector('.msg.agent.confirm')).toBeNull()
  })

  it('shows a stopped turn with Continue, and the agent working while it waits for a model', () => {
    const onContinue = vi.fn()
    render(
      <Conversation
        {...props}
        onContinue={onContinue}
        view={view([
          user('u1', 'Q'),
          {
            id: 'n',
            kind: 'notice',
            at: '',
            code: 'stopped',
            text: '',
            tone: 'info',
            action: 'continue',
          },
        ])}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalled()
    cleanup()
    render(
      <Conversation
        {...props}
        view={view([user('u1', 'Q')], {
          live: { phase: 'thinking', tools: [], reasoning: null, text: null, startedAt: '' },
        })}
      />,
    )
    expect(screen.getByText(/Thinking/)).toBeTruthy()
  })
})
