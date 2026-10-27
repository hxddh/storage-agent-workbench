// @vitest-environment jsdom
import type { IssueRow, TaskView, UiEntry } from '@shared/contract'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sources } from './Sources'

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

describe('sources', () => {
  it('starts as a compact index and opens risks on demand', () => {
    render(<Sources view={view([survey])} lang="en" focusId={null} />)
    expect(document.querySelector('.source-index')).toBeTruthy()
    expect(screen.queryByText('Bucket is publicly accessible')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Risks/ }))
    expect(screen.getByText('Bucket is publicly accessible')).toBeTruthy()
  })

  it('lets the user accept a risk, and folds it once accepted', () => {
    const { rerender } = render(<Sources view={view([survey])} lang="en" focusId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Risks/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept risk' }))
    expect(acceptIssue).toHaveBeenCalledWith('i1', true)
    rerender(
      <Sources
        view={view([survey], { issueStatus: { i1: 'accepted' } })}
        lang="en"
        focusId={null}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Risks/ }))
    expect(screen.getByRole('button', { name: /1 accepted/ })).toBeTruthy()
  })

  it('shows one receipt with tokens under tool calls', () => {
    render(<Sources view={view([survey])} lang="en" focusId={null} />)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Tool calls/ }))
    expect(screen.getByRole('status').textContent).toBe('1 tool call · 1.5s · 10.2k tokens')
  })

  it('keeps capped coverage under Not read', () => {
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
    render(<Sources view={view([capped])} lang="en" focusId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Not read/ }))
    expect(screen.getByText(/1 outside this run/)).toBeTruthy()
  })

  it('renders estate history inside the data section', () => {
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
    render(<Sources view={view([history])} lang="en" focusId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Data/ }))
    expect(screen.getByText('History')).toBeTruthy()
    expect(screen.getByText('Public access — fixed')).toBeTruthy()
  })

  it('shows partial access coverage as open and inside the data section', () => {
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
    render(<Sources view={view([access])} lang="en" focusId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Access/ }))
    expect(screen.getByText('2/4 IAM users and roles evaluated · 1 undecided')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Not read/ }))
    expect(screen.getByText(/3 access reads are partial/)).toBeTruthy()
  })

  it('shows one change plan with its manual blocker', () => {
    const change: UiEntry = {
      id: 'f',
      kind: 'tool',
      at: '2026-01-01T00:00:01Z',
      name: 'change_plan',
      target: 'all risks',
      status: 'done',
      note: '2 steps',
      ms: 10,
      view: {
        kind: 'change',
        providerId: 'p1',
        bucket: 'demo',
        code: 'public_exposure',
        formats: [
          { label: 'AWS CLI', language: 'bash', text: 'aws s3api put-public-access-block' },
        ],
        impact: { verdict: 'low', reasons: ['Blocks new public grants.'], gap: null },
        plan: {
          summary: '2 steps · 1 bucket · 1 manual',
          baseline: null,
          residual: [{ bucket: 'demo', code: 'no_encryption', title: 'No default encryption' }],
          steps: [
            {
              id: 'policy:demo',
              bucket: 'demo',
              codes: ['public_exposure'],
              title: 'Bucket is publicly accessible',
              severity: 'high',
              formats: [
                { label: 'AWS CLI', language: 'bash', text: 'aws s3api put-public-access-block' },
              ],
              impact: { verdict: 'low', reasons: ['Blocks new public grants.'], gap: null },
              notes: [],
              status: 'ready',
              blockers: [],
            },
            {
              id: 'lifecycle:demo',
              bucket: 'demo',
              codes: ['no_abort_mpu'],
              title: 'Incomplete uploads are never cleaned up',
              severity: 'medium',
              formats: [{ label: 'New rules', language: 'json', text: '{"Rules":[]}' }],
              impact: { verdict: 'caution', reasons: ['Rules are replaced.'], gap: null },
              notes: [],
              status: 'manual',
              blockers: ['The current lifecycle configuration could not be read.'],
            },
          ],
        },
      },
    }
    render(<Sources view={view([change])} lang="en" focusId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Change plan/ }))
    expect(screen.getByRole('heading', { name: 'Change plan' })).toBeTruthy()
    expect(screen.getByText('2 steps · 1 bucket · 1 manual · 1 not covered')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Incomplete uploads are never cleaned up/ }))
    expect(screen.getByText('The current lifecycle configuration could not be read.')).toBeTruthy()
  })

  it('compares a re-check with the plan instead of claiming the change worked', () => {
    const reverify: UiEntry = {
      id: 'r',
      kind: 'reverify',
      at: '2026-01-02T00:00:00Z',
      report: {
        at: '2026-01-02T00:00:00Z',
        checked: 3,
        skipped: 0,
        changes: [],
        opened: 0,
        resolved: 0,
        undecided: 0,
        plan: {
          confirmed: 1,
          notApplied: 1,
          unknown: 1,
          steps: [
            {
              bucket: 'demo',
              code: 'public_exposure',
              title: 'Bucket is publicly accessible',
              status: 'confirmed',
            },
            {
              bucket: 'demo',
              code: 'no_encryption',
              title: 'No default encryption',
              status: 'not_applied',
            },
            {
              bucket: 'private',
              code: 'no_abort_mpu',
              title: 'Incomplete uploads are never cleaned up',
              status: 'unknown',
            },
          ],
        },
      },
    }
    render(<Sources view={view([survey, reverify])} lang="en" focusId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Checked again/ }))
    expect(screen.getByText('1 confirmed · 1 not applied · 1 unknown')).toBeTruthy()
    expect(screen.getByText('confirmed')).toBeTruthy()
    expect(screen.getByText('not applied')).toBeTruthy()
    expect(screen.getByText('still unknown')).toBeTruthy()
  })

  it('shows a method separately from tool calls', () => {
    const skill: UiEntry = {
      id: 'k',
      kind: 'tool',
      at: '2026-01-01T00:00:01Z',
      name: 'skill',
      target: 'access',
      status: 'done',
      note: null,
      ms: 0,
      view: {
        kind: 'skill',
        name: 'access',
        title: 'Access evidence',
        description: 'Who can reach a bucket.',
        body: 'Read the policy.',
      },
    }
    render(<Sources view={view([survey, skill])} lang="en" focusId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Methods/ }))
    expect(screen.getByText('Access evidence')).toBeTruthy()
    expect(screen.getByText('Who can reach a bucket.')).toBeTruthy()
  })
})
