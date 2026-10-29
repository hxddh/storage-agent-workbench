// @vitest-environment jsdom
import type { IssueRow, Live, TaskView, UiEntry } from '@shared/contract'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Run } from './Run'

const issue = (id: string, code: string, title: string, bucket = 'demo'): IssueRow => ({
  id,
  provider: 'p1',
  bucket,
  code,
  severity: 'high',
  status: 'open',
  title,
  detail: 'The policy lets anyone read objects',
  openedAt: '2026-01-01T00:00:00Z',
  lastSeenAt: '2026-01-01T00:00:00Z',
  recurred: 0,
})

function view(entries: UiEntry[], extra: Partial<TaskView> = {}): TaskView {
  return {
    task: {
      id: 't',
      title: 'Which buckets are public?',
      state: 'ready',
      createdAt: '',
      updatedAt: '',
      pinned: false,
    },
    entries,
    live: null,
    hasOlder: false,
    cursor: null,
    usage: null,
    issueStatus: {},
    ...extra,
  }
}

const survey: UiEntry = {
  id: 's',
  kind: 'tool',
  at: '2026-01-01T00:00:01Z',
  name: 'survey',
  target: 'Demo',
  status: 'done',
  note: '1 bucket',
  ms: 1500,
  evidenceId: 'ev-survey',
  view: {
    kind: 'survey',
    provider: 'Demo',
    providerId: 'p1',
    buckets: {
      columns: ['Bucket', 'Public', 'Encryption'],
      rows: [['demo', 'public', 'off']],
    },
    issues: [issue('i1', 'public_exposure', 'Bucket is publicly accessible')],
    observations: [],
    coverage: {
      visible: 1,
      processed: 1,
      truncated: false,
      pending: 0,
      denied: [],
      unknown: [],
      gone: [],
    },
    changed: { opened: 1, resolved: 0, recurred: 0 },
  },
}

const plan: UiEntry = {
  id: 'plan',
  kind: 'tool',
  at: '2026-01-01T00:00:01Z',
  name: 'plan',
  target: 'investigation',
  status: 'done',
  note: '2 steps',
  ms: 0,
  view: {
    kind: 'plan',
    steps: [
      { title: 'Read the account', status: 'done' },
      { title: 'Compose the answer', status: 'done' },
    ],
  },
}

const user = (id = 'u', text = 'Which buckets are public?'): UiEntry => ({
  id,
  kind: 'user',
  at: '2026-01-01T00:00:00Z',
  text,
  attachments: [],
})

const fallback = (text: string): Extract<UiEntry, { kind: 'answer' }> => ({
  id: 'a',
  kind: 'answer',
  at: '2026-01-01T00:00:02Z',
  text,
})

beforeEach(() => {
  Object.defineProperty(window, 'agent', {
    configurable: true,
    value: { acceptIssue: vi.fn(async () => undefined), saveText: vi.fn() },
  })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
})

describe('the run', () => {
  it('renders the answer first and keeps the trace folded until opened', () => {
    render(
      <Run
        view={view([user(), plan, survey, fallback('Only `demo` is public.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    expect(document.querySelector('.run-question')?.textContent).toBe('Which buckets are public?')
    expect(screen.getByText(/Only/)).toBeTruthy()
    expect(document.querySelector('.run-proof')).toBeNull()
    expect(screen.queryByText('Read the account')).toBeNull()
    expect(screen.getByRole('button', { name: /Work/ })).toBeTruthy()
    expect(screen.getByText(/Worked for/)).toBeTruthy()
    const answer = document.querySelector('.run-answer')
    const work = document.querySelector('.run-work')
    expect(
      answer && work && answer.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Work/ }))
    expect(screen.getByText('Read the account')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sources/ })).toBeNull()
  })

  it('puts the live trace first, with completed calls still present', () => {
    const now = new Date(Date.now() - 1000).toISOString()
    const live: Live = {
      phase: 'tool',
      tools: [
        {
          callId: 'c1',
          name: 'survey',
          target: 'Demo',
          note: '3 of 4',
          status: 'running',
          startedAt: now,
        },
        {
          callId: 'c2',
          name: 'config',
          target: 'demo-public',
          note: '4 findings',
          status: 'done',
          startedAt: now,
        },
      ],
      reasoning: null,
      text: null,
      startedAt: now,
    }
    render(
      <Run
        view={view([user(), plan], { live })}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    expect(document.querySelector('.run-work')).toBeTruthy()
    const answer = document.querySelector('.run-answer')
    const work = document.querySelector('.run-work')
    expect(
      work && answer && work.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getByText('Read account')).toBeTruthy()
    expect(screen.getByText('3 of 4')).toBeTruthy()
    expect(screen.getByText('Reviewed configuration')).toBeTruthy()
    expect(screen.getByText('4 findings')).toBeTruthy()
  })

  it('shows provider reasoning summary when the trace is expanded', () => {
    const reasoning: UiEntry = {
      id: 'reason-1',
      kind: 'reasoning',
      at: '2026-01-01T00:00:01Z',
      text: 'Check the public access block before concluding.',
    }
    render(
      <Run
        view={view([user(), reasoning, survey, fallback('Only `demo` is public.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Work/ }))
    fireEvent.click(screen.getByRole('button', { name: /Thought/ }))
    expect(screen.getAllByText('Check the public access block before concluding.')).toHaveLength(2)
  })

  it('shows a visible validation event in the trace', () => {
    const validation: UiEntry = {
      id: 'v1',
      kind: 'validation',
      at: '2026-01-01T00:00:02Z',
      text: 'Your answer names `ghost`, which no tool result shows.',
      tone: 'warn',
    }
    render(
      <Run
        view={view([user(), validation, fallback('Only `demo` is public.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Work/ }))
    expect(screen.getByText('Claim checked')).toBeTruthy()
    expect(screen.getByText(/no tool result shows/)).toBeTruthy()
  })

  it('renders a clarifying question and sends its chosen option', () => {
    const onClarify = vi.fn()
    const ask: UiEntry = {
      id: 'ask',
      kind: 'tool',
      at: '2026-01-01T00:00:01Z',
      name: 'ask',
      target: 'clarify',
      status: 'done',
      note: null,
      ms: 0,
      view: {
        kind: 'question',
        question: 'Which account should I read?',
        options: ['Demo', 'Production'],
      },
    }
    render(
      <Run
        view={view([user(), ask])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
        onClarify={onClarify}
      />,
    )
    expect(screen.getByText('Which account should I read?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Production' }))
    expect(onClarify).toHaveBeenCalledWith('Production')
  })

  it('does not invent a proof when the answer has no citation', () => {
    render(
      <Run
        view={view([user(), survey, fallback('One bucket is public.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    expect(document.querySelector('.run-proof')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Findings/ }))
    expect(screen.getByText('Bucket is publicly accessible')).toBeTruthy()
  })

  it('scopes the run to the latest request instead of reusing old evidence', () => {
    render(
      <Run
        view={view([
          user(),
          survey,
          fallback('Only `demo` is public.'),
          user('u2', 'What changed?'),
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    expect(document.querySelector('.run-scope')?.textContent).toContain('Not read yet')
    expect(document.querySelector('.run-proof')).toBeNull()
    expect(screen.queryByRole('button', { name: /Findings/ })).toBeNull()
    expect(screen.queryByText('Bucket is publicly accessible')).toBeNull()
  })

  it('accepts normal assistant prose as the answer', () => {
    render(
      <Run
        view={view([user(), survey, fallback('Only `demo` is public.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    expect(document.querySelector('.run-summary')?.textContent).toContain('Only demo is public.')
    fireEvent.click(screen.getByRole('button', { name: /Findings/ }))
    expect(screen.getByText('Bucket is publicly accessible')).toBeTruthy()
  })

  it('renders an inline citation and opens its evidence peek', async () => {
    render(
      <Run
        view={view([user(), survey, fallback('Only `demo` is public [1](#ev-ev-survey).')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    await waitFor(() => expect(document.querySelector('.run-cite')).toBeTruthy())
    fireEvent.click(document.querySelector('.run-cite')!)
    expect(document.querySelector('.run-peek')).toBeTruthy()
    expect(document.querySelector('.run-peek table')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open in trace/ }))
    expect(screen.getByRole('button', { name: /Work/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('warns when a prose citation does not resolve', () => {
    render(
      <Run
        view={view([user(), survey, fallback('Only `demo` is public [1](#ev-99).')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    expect(screen.getByText(/One citation did not resolve/)).toBeTruthy()
    expect(document.querySelector('.run-cite')).toBeNull()
  })

  it('renders a deterministic check without a fake question', () => {
    render(
      <Run
        view={view([
          { id: 'c', kind: 'check', at: '2026-01-01T00:00:00Z', mode: 'check' },
          survey,
          { ...fallback('`demo` is public. [1](#ev-ev-survey)'), source: 'check' },
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    expect(document.querySelector('.run-question')).toBeNull()
    expect(screen.getByText('Deterministic account check')).toBeTruthy()
    // The scripted answer cites its own call, like a model's answer.
    expect(document.querySelector('.run-cite')).toBeTruthy()
    expect(screen.getAllByText(/demo/).length).toBeGreaterThan(0)
  })

  it('keeps earlier turns compact and expands their answer', () => {
    render(
      <Run
        view={view([
          { id: 'c', kind: 'check', at: '2026-01-01T00:00:00Z', mode: 'check' },
          survey,
          fallback('`demo` is public.'),
          user('u2', 'What changed?'),
          { ...survey, id: 's2' },
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Earlier in this task/ }))
    expect(screen.getByText('Deterministic account check')).toBeTruthy()
    expect(document.querySelector('.run-question')?.textContent).toBe('What changed?')
  })

  it('shows every finding in the evidence panel, without a five-item cap', () => {
    const many: UiEntry = {
      ...survey,
      id: 'many',
      view: {
        ...(survey.view as Extract<
          NonNullable<Extract<UiEntry, { kind: 'tool' }>['view']>,
          { kind: 'survey' }
        >),
        issues: Array.from({ length: 6 }, (_, index) => ({
          ...issue(`i${index}`, 'public_exposure', `Risk ${index + 1}`, `demo-${index}`),
        })),
      },
    }
    render(
      <Run
        view={view([user(), many, fallback('Six buckets need attention.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onRecheck={() => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Findings/ }))
    expect(document.querySelectorAll('.run-finding-line').length).toBe(6)
    expect(screen.queryByText(/more risks/)).toBeNull()
  })
})
