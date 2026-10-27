// @vitest-environment jsdom
import type { IssueRow, TaskView, UiEntry } from '@shared/contract'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Run } from './Run'

const issue = (id: string, code: string, title: string): IssueRow => ({
  id,
  provider: 'p1',
  bucket: 'demo',
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
      { title: 'Compose the answer', status: 'active' },
    ],
  },
}

const report: UiEntry = {
  id: 'report',
  kind: 'tool',
  at: '2026-01-01T00:00:02Z',
  name: 'report',
  target: 'answer',
  status: 'done',
  note: '1 block',
  ms: 0,
  view: {
    kind: 'report',
    blocks: [{ kind: 'summary', text: 'Only `demo` is public.', evidence: ['ev-survey'] }],
  },
}

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
  it('shows the composed summary and evidence, not the finished process plan', () => {
    render(
      <Run
        view={view([
          {
            id: 'u',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which buckets are public?',
            attachments: [],
          },
          plan,
          survey,
          report,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.run-question')?.textContent).toBe('Which buckets are public?')
    expect(screen.queryByText('Read the account')).toBeNull()
    expect(screen.getByText(/Only/)).toBeTruthy()
    expect(document.querySelector('.verdict code.ungrounded')).toBeNull()
    expect(screen.getAllByText('Bucket is publicly accessible').length).toBeGreaterThan(0)
    expect(document.querySelector('.run-evidence-wrap')?.className).toContain('is-collapsed')
    fireEvent.click(screen.getByRole('button', { name: /Sources/ }))
    expect(document.querySelector('.run-evidence-wrap')?.className).not.toContain('is-collapsed')
  })

  it('omits a table block whose evidence is missing and says so', () => {
    const badReport: UiEntry = {
      ...report,
      view: {
        kind: 'report',
        blocks: [{ kind: 'table', evidence: ['missing'], title: 'Buckets' }],
      },
    }
    render(
      <Run
        view={view([
          {
            id: 'u',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which buckets are public?',
            attachments: [],
          },
          survey,
          badReport,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByText(/no matching result/)).toBeTruthy()
    expect(screen.queryByText('Buckets in the reading')).toBeNull()
  })

  it('synthesizes a report for a model-free audit', () => {
    render(
      <Run
        view={view([
          survey,
          { id: 'a', kind: 'answer', at: '2026-01-01T00:00:02Z', text: '`demo` is public.' },
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByText('Deterministic account check')).toBeTruthy()
    expect(screen.getAllByText(/demo is public/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Sources/ }))
    fireEvent.click(screen.getByRole('button', { name: /Risks/ }))
    expect(screen.getByText('Bucket is publicly accessible')).toBeTruthy()
  })
  it('renders a table block from the evidence it cites', () => {
    const tableReport: UiEntry = {
      ...report,
      view: {
        kind: 'report',
        blocks: [
          { kind: 'summary', text: 'One bucket is public.', evidence: ['ev-survey'] },
          { kind: 'table', evidence: ['ev-survey'], title: 'Buckets in the reading' },
        ],
      },
    }
    render(
      <Run
        view={view([
          {
            id: 'u',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which buckets are public?',
            attachments: [],
          },
          survey,
          tableReport,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByText('Buckets in the reading')).toBeTruthy()
    expect(document.querySelector('.run-block table')).toBeTruthy()
    expect(screen.getByText(/Read account/)).toBeTruthy()
  })

  it('shows the latest reading when the report did not compose a table', () => {
    render(
      <Run
        view={view([
          {
            id: 'u',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which buckets are public?',
            attachments: [],
          },
          survey,
          report,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.run-preview table')).toBeTruthy()
    expect(screen.getByText('Buckets')).toBeTruthy()
  })

  it('renders a controlled markdown block with sections and lists', async () => {
    const markdownReport: UiEntry = {
      ...report,
      view: {
        kind: 'report',
        blocks: [
          {
            kind: 'markdown',
            title: 'Details',
            text: '## Detail\n\n- one\n- two',
            evidence: ['ev-survey'],
          },
        ],
      },
    }
    render(
      <Run
        view={view([
          {
            id: 'u',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which buckets are public?',
            attachments: [],
          },
          survey,
          markdownReport,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByText('Details')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Detail' })).toBeTruthy())
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('renders an inline citation from a summary', async () => {
    const cited: UiEntry = {
      ...report,
      view: {
        kind: 'report',
        blocks: [
          {
            kind: 'summary',
            text: 'Only `demo` is public [1](#ev-1).',
            evidence: ['ev-survey'],
          },
        ],
      },
    }
    render(
      <Run
        view={view([
          {
            id: 'u',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which buckets are public?',
            attachments: [],
          },
          survey,
          cited,
        ])}
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

  it('does not show a stale table under a new question', () => {
    const tableReport: UiEntry = {
      ...report,
      view: {
        kind: 'report',
        blocks: [
          { kind: 'summary', text: 'Only `demo` is public.', evidence: ['ev-survey'] },
          { kind: 'table', evidence: ['ev-survey'], title: 'Buckets in the reading' },
        ],
      },
    }
    render(
      <Run
        view={view([
          {
            id: 'u1',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which buckets are public?',
            attachments: [],
          },
          survey,
          tableReport,
          {
            id: 'u2',
            kind: 'user',
            at: '2026-01-01T00:00:03Z',
            text: 'What history do you remember?',
            attachments: [],
          },
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByText('This answer belongs to an earlier question.')).toBeTruthy()
    expect(screen.getByText(/Only/)).toBeTruthy()
    expect(screen.queryByText('Buckets in the reading')).toBeNull()
  })

  it('does not put the audit task title where a question belongs', () => {
    render(
      <Run
        view={view([
          survey,
          { id: 'a', kind: 'answer', at: '2026-01-01T00:00:02Z', text: '`demo` is public.' },
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.run-question')).toBeNull()
    expect(screen.getByText('Deterministic account check')).toBeTruthy()
  })

  it('keeps an earlier model-free check when a follow-up question starts', () => {
    render(
      <Run
        view={view([
          survey,
          { id: 'a', kind: 'answer', at: '2026-01-01T00:00:02Z', text: '`demo` is public.' },
          {
            id: 'u2',
            kind: 'user',
            at: '2026-01-01T00:00:03Z',
            text: 'What changed?',
            attachments: [],
          },
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

  it('renders an older task with its answer entry on the one Run page', () => {
    render(
      <Run
        view={view([
          {
            id: 'u',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which buckets are public?',
            attachments: [],
          },
          survey,
          {
            id: 'legacy-answer',
            kind: 'answer',
            at: '2026-01-01T00:00:02Z',
            text: 'Only `demo` is public.',
          },
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.run-summary')?.textContent).toContain('Only demo is public.')
    expect(screen.queryByText('The agent has not composed an answer yet.')).toBeNull()
    expect(screen.getByText('Bucket is publicly accessible')).toBeTruthy()
  })

  it('keeps current risks outside a findings block in Sources', () => {
    const two: UiEntry = {
      ...survey,
      id: 'two',
      view: {
        ...(survey.view as Extract<
          NonNullable<Extract<UiEntry, { kind: 'tool' }>['view']>,
          { kind: 'survey' }
        >),
        buckets: {
          columns: ['Bucket', 'Public'],
          rows: [
            ['demo-a', 'public'],
            ['demo-b', 'public'],
          ],
        },
        issues: [
          { ...issue('i1', 'public_exposure', 'A is public'), bucket: 'demo-a' },
          { ...issue('i2', 'public_exposure', 'B is public'), bucket: 'demo-b' },
        ],
        coverage: {
          visible: 2,
          processed: 2,
          truncated: false,
          pending: 0,
          denied: [],
          unknown: [],
          gone: [],
        },
      },
    }
    const filtered: UiEntry = {
      ...report,
      view: {
        kind: 'report',
        blocks: [{ kind: 'findings', bucket: 'demo-a', limit: 1 }],
      },
    }
    render(
      <Run
        view={view([
          {
            id: 'u',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which risk?',
            attachments: [],
          },
          two,
          filtered,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByText('A is public')).toBeTruthy()
    expect(screen.queryByText('B is public')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Sources/ }))
    fireEvent.click(screen.getByRole('button', { name: /Risks/ }))
    expect(screen.getByText('B is public')).toBeTruthy()
  })

  it('expands more risks in place instead of opening Sources', () => {
    const many: UiEntry = {
      ...survey,
      id: 'many',
      view: {
        ...(survey.view as Extract<
          NonNullable<Extract<UiEntry, { kind: 'tool' }>['view']>,
          { kind: 'survey' }
        >),
        issues: Array.from({ length: 6 }, (_, index) => ({
          ...issue(`i${index}`, 'public_exposure', `Risk ${index + 1}`),
          bucket: `demo-${index}`,
        })),
      },
    }
    const one: UiEntry = {
      ...report,
      view: { kind: 'report', blocks: [{ kind: 'findings', limit: 1 }] },
    }
    render(
      <Run
        view={view([
          {
            id: 'u',
            kind: 'user',
            at: '2026-01-01T00:00:00Z',
            text: 'Which risks?',
            attachments: [],
          },
          many,
          one,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelectorAll('.findings-list .finding-row').length).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /5 more risks/ }))
    expect(document.querySelectorAll('.findings-list .finding-row').length).toBe(6)
    expect(document.querySelector('.run-evidence-wrap')?.className).toContain('is-collapsed')
  })

  it('warns when a prose citation does not resolve', () => {
    const cited: UiEntry = {
      ...report,
      view: {
        kind: 'report',
        blocks: [
          {
            kind: 'summary',
            text: 'Only `demo` is public [1](#ev-99).',
            evidence: ['ev-survey'],
          },
        ],
      },
    }
    render(
      <Run
        view={view([
          { id: 'u', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'Public?', attachments: [] },
          survey,
          cited,
        ])}
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

  it('words a deterministic check without a hard-coded English title', () => {
    render(
      <Run
        view={view([
          survey,
          { id: 'a', kind: 'answer', at: '2026-01-01T00:00:02Z', text: '`demo` 是公开的。' },
        ])}
        lang="zh"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.queryByText('Open findings')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /来源/ }))
    expect(screen.getByRole('button', { name: /风险/ })).toBeTruthy()
  })
})
