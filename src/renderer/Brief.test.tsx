// @vitest-environment jsdom
import type { IssueRow, TaskView, UiEntry } from '@shared/contract'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Brief } from './Brief'

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
    usage: { input: 9000, output: 1200, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
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
  view: {
    kind: 'survey',
    provider: 'Demo',
    providerId: 'p1',
    buckets: { columns: ['Bucket', 'Public'], rows: [['demo', 'public']] },
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

const acceptIssue = vi.fn(async () => undefined)

beforeEach(() => {
  Object.defineProperty(window, 'agent', {
    configurable: true,
    value: { acceptIssue, saveText: vi.fn() },
  })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  acceptIssue.mockClear()
})

describe('the brief', () => {
  it('shows the verdict, the finding, a one-bucket data line and a receipt with tokens', () => {
    render(
      <Brief
        view={view([
          { id: 'u', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'q', attachments: [] },
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
    expect(screen.getByText('Bucket is publicly accessible')).toBeTruthy()
    expect(screen.getByText('1 bucket')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('1 check · 1.5s · 10.2k tokens')
    expect(document.querySelector('.verdict code.ungrounded')).toBeNull()
  })

  it('shows the reading scope and never hides a capped survey', () => {
    const surveyView = survey.view as Extract<
      NonNullable<Extract<UiEntry, { kind: 'tool' }>['view']>,
      { kind: 'survey' }
    >
    const capped: UiEntry = {
      ...survey,
      view: {
        ...surveyView,
        coverage: { ...surveyView.coverage, visible: 3, processed: 2, truncated: true },
      },
    }
    render(
      <Brief
        view={view([capped])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.brief-scope')?.textContent).toContain('2/3 buckets checked')
    expect(document.querySelector('.brief-scope')?.textContent).toContain('Reads open: 1')
    expect(document.querySelector('.blind-section')?.textContent).toContain('1 outside this run')
  })

  it('says reads are complete only when the account coverage is closed', () => {
    render(
      <Brief
        view={view([
          { id: 'u', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'q', attachments: [] },
          survey,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.brief-scope')?.textContent).toContain('Reads complete')
    expect(document.querySelector('.brief-scope')?.textContent).toContain('1/1 buckets checked')
  })

  it('renders estate history inside the existing data section', () => {
    const history: UiEntry = {
      id: 'h',
      kind: 'tool',
      at: '2026-01-01T00:00:01Z',
      name: 'estate',
      target: 'Demo',
      status: 'done',
      note: null,
      ms: 10,
      view: {
        kind: 'estate',
        providerId: 'p1',
        buckets: { columns: ['Bucket'], rows: [['demo']] },
        issues: [],
        notes: [],
        history: {
          columns: ['When', 'Event', 'Bucket', 'Evidence'],
          rows: [['2026-01-01', 'resolved', 'demo', 'Public access — fixed']],
        },
      },
    }
    render(
      <Brief
        view={view([
          { id: 'u', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'q', attachments: [] },
          history,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByText('History')).toBeTruthy()
    expect(screen.getByText('resolved')).toBeTruthy()
    expect(screen.getByText('Public access — fixed')).toBeTruthy()
  })

  it('counts partial access coverage as an open read', () => {
    const access: UiEntry = {
      id: 'a',
      kind: 'tool',
      at: '2026-01-01T00:00:01Z',
      name: 'config',
      target: 'demo',
      status: 'done',
      note: null,
      ms: 10,
      view: {
        kind: 'config',
        bucket: 'demo',
        providerId: 'p1',
        aspect: 'access',
        access: [],
        accessCoverage: {
          principals: 4,
          evaluated: 2,
          undecided: 1,
          truncated: false,
          sources: ['iam'],
        },
        findings: [],
      },
    }
    render(
      <Brief
        view={view([
          { id: 'u', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'q', attachments: [] },
          access,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.brief-scope')?.textContent).toContain('Reads open: 3')
    expect(document.querySelector('.blind-section')?.textContent).toContain(
      '3 access reads are partial',
    )
    expect(screen.getByText('2/4 IAM users and roles evaluated · 1 undecided')).toBeTruthy()
  })

  it('never claims complete reads after a failed read', () => {
    const failed: UiEntry = { ...survey, id: 'f', status: 'failed', view: null }
    render(
      <Brief
        view={view([
          { id: 'u', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'q', attachments: [] },
          failed,
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(document.querySelector('.brief-scope')?.textContent).toContain('Reads open: 1')
    expect(document.querySelector('.blind-section')?.textContent).toContain('reads failed')
  })

  it('lets the user accept a risk, and folds it once accepted', () => {
    const { rerender } = render(
      <Brief
        view={view([survey])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept risk' }))
    expect(acceptIssue).toHaveBeenCalledWith('i1', true)
    rerender(
      <Brief
        view={view([survey], { issueStatus: { i1: 'accepted' } })}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: /1 accepted/ })).toBeTruthy()
  })

  it('marks a name the checks never showed', async () => {
    render(
      <Brief
        view={view([
          survey,
          { id: 'a', kind: 'answer', at: '2026-01-01T00:00:02Z', text: '`ghost` is public.' },
        ])}
        lang="en"
        focusId={null}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onReverify={async () => undefined}
      />,
    )
    await waitFor(() =>
      expect(document.querySelector('.verdict code.ungrounded')?.textContent).toBe('ghost'),
    )
    expect(screen.getByText('Not every name in this answer appears in a check.')).toBeTruthy()
  })

  it('words a stopped run in the user language and offers Continue', () => {
    const onContinue = vi.fn()
    render(
      <Brief
        view={view([
          { id: 'u', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'q', attachments: [] },
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
        lang="zh"
        focusId={null}
        onRetry={() => undefined}
        onContinue={onContinue}
        onReverify={async () => undefined}
      />,
    )
    expect(screen.getByText('已停止。已读取的内容会保留。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(onContinue).toHaveBeenCalled()
  })
})
