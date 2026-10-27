// @vitest-environment jsdom
import type { IssueRow, TaskView, UiEntry } from '@shared/contract'
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

const fallback = (text: string): UiEntry => ({
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
  it('renders the answer, its primary evidence and no settled plan', () => {
    render(
      <Run
        view={view([user(), plan, survey, fallback('Only `demo` is public.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.run-question')?.textContent).toBe('Which buckets are public?')
    expect(screen.getByText(/Only/)).toBeTruthy()
    expect(document.querySelector('.run-proof table')).toBeTruthy()
    expect(screen.queryByText('Read the account')).toBeNull()
    expect(document.querySelector('.run-evidence-wrap')?.className).toContain('is-collapsed')
    fireEvent.click(screen.getByRole('button', { name: /Sources/ }))
    expect(document.querySelector('.run-evidence-wrap')?.className).not.toContain('is-collapsed')
  })

  it('shows the latest reading when the answer has no citation', () => {
    render(
      <Run
        view={view([user(), survey, fallback('One bucket is public.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.run-proof table')).toBeTruthy()
  })

  it('accepts normal assistant prose as the answer', () => {
    render(
      <Run
        view={view([user(), survey, fallback('Only `demo` is public.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.run-summary')?.textContent).toContain('Only demo is public.')
    fireEvent.click(screen.getByRole('button', { name: /Sources/ }))
    fireEvent.click(screen.getByRole('button', { name: /Risks/ }))
    expect(screen.getByText('Bucket is publicly accessible')).toBeTruthy()
  })

  it('renders an inline citation and opens its check', async () => {
    render(
      <Run
        view={view([user(), survey, fallback('Only `demo` is public [1](#ev-ev-survey).')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    await waitFor(() => expect(document.querySelector('.run-cite')).toBeTruthy())
    fireEvent.click(document.querySelector('.run-cite')!)
    expect(document.querySelector('.run-evidence-wrap')?.className).not.toContain('is-collapsed')
  })

  it('warns when a prose citation does not resolve', () => {
    render(
      <Run
        view={view([user(), survey, fallback('Only `demo` is public [1](#ev-99).')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByText(/One citation did not resolve/)).toBeTruthy()
    expect(document.querySelector('.run-cite')).toBeNull()
  })

  it('renders a deterministic check without a fake question', () => {
    render(
      <Run
        view={view([survey, fallback('`demo` is public.')])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.run-question')).toBeNull()
    expect(screen.getByText('Deterministic account check')).toBeTruthy()
    expect(screen.getAllByText(/demo/).length).toBeGreaterThan(0)
  })

  it('keeps earlier turns compact and expands their answer', () => {
    render(
      <Run
        view={view([
          survey,
          fallback('`demo` is public.'),
          user('u2', 'What changed?'),
          { ...survey, id: 's2' },
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Earlier in this task/ }))
    expect(screen.getByText('Deterministic account check')).toBeTruthy()
    expect(document.querySelector('.run-question')?.textContent).toBe('What changed?')
  })

  it('expands more risks in place inside Sources', () => {
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
        onReverify={async () => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Sources/ }))
    fireEvent.click(screen.getByRole('button', { name: /Risks/ }))
    expect(document.querySelectorAll('.run-sources .finding-row').length).toBe(5)
    fireEvent.click(screen.getByRole('button', { name: /1 more risk/ }))
    expect(document.querySelectorAll('.run-sources .finding-row').length).toBe(6)
    expect(document.querySelector('.run-evidence-wrap')?.className).not.toContain('is-collapsed')
  })
})
