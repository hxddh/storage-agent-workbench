// @vitest-environment jsdom
import type { IssueRow, TaskView, UiEntry } from '@shared/contract'
import { cleanup, render, screen } from '@testing-library/react'
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
  it('shows the agent plan, composed summary and deterministic evidence', () => {
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
    expect(screen.getByText('Read the account')).toBeTruthy()
    expect(screen.getByText(/Only/)).toBeTruthy()
    expect(screen.getByText('Bucket is publicly accessible')).toBeTruthy()
    expect(document.querySelector('.verdict code.ungrounded')).toBeNull()
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
    expect(screen.getByText(/had no matching evidence/)).toBeTruthy()
    expect(screen.queryByText('Buckets')).toBeNull()
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
    expect(screen.getByText(/View evidence/)).toBeTruthy()
  })
})
