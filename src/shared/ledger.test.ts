import { describe, expect, it } from 'vitest'
import type { UiEntry } from './contract'
import { foldLedger, readState, runStart } from './ledger'
import { request, survey, tool } from './testing'

describe('turn boundaries', () => {
  it('starts a turn at the latest user message, never at a steer', () => {
    const entries: UiEntry[] = [
      request('first'),
      tool('survey', survey(['a'])),
      request('second'),
      { id: 's', kind: 'steer', at: '', text: 'narrow it', attachments: [] },
    ]
    expect(runStart(entries)).toBe(2)
  })
})

describe('coverage', () => {
  it('keeps the latest account survey of the run and its open reads', () => {
    const ledger = foldLedger([
      request(),
      tool(
        'survey',
        survey(['a', 'b', 'c'], {
          coverage: { visible: 10, processed: 3, pending: 2, truncated: true, denied: ['secret'] },
        }),
      ),
    ])
    const state = readState(ledger)
    expect(state.pending).toBe(2)
    expect(state.truncated).toBe(5)
    expect(state.denied).toBe(1)
    expect(state.complete).toBe(false)
  })

  it('never lets a narrowed re-read stand in for the account', () => {
    const alone = foldLedger([request(), tool('survey', survey(['a'], { scoped: true }))])
    expect(alone.coverage).toEqual([])
    const merged = foldLedger([
      request(),
      tool('survey', survey(['a', 'b'], { coverage: { visible: 3, pending: 1, truncated: true } })),
      tool('survey', survey(['c'], { scoped: true })),
    ])
    expect(readState(merged).pending).toBe(1)
    expect(readState(merged).complete).toBe(false)
  })

  it('belongs to the current run: an earlier run does not close or open it', () => {
    const ledger = foldLedger([
      request(),
      tool('survey', survey(['a'], { coverage: { denied: ['a'] } })),
      request('again'),
      tool('survey', survey(['a'])),
    ])
    expect(readState(ledger).complete).toBe(true)
  })

  it('keeps a failed storage read and an open access question open', () => {
    const ledger = foldLedger([
      request(),
      tool('survey', survey(['a'])),
      tool('config', null, { status: 'failed', target: 'a' }),
      tool('config', {
        kind: 'config',
        bucket: 'a',
        providerId: 'p1',
        aspect: 'access',
        findings: [],
        accessCoverage: {
          principals: 4,
          evaluated: 3,
          undecided: 1,
          truncated: false,
          sources: [],
        },
      }),
    ])
    const state = readState(ledger)
    expect(state.failed).toBe(1)
    expect(state.access).toBe(2)
    expect(state.complete).toBe(false)
  })

  it('replaces one bucket aspect blind spot when that review is repeated', () => {
    const blind = (findings: { severity: 'blind' | 'ok'; title: string; code: string }[]) =>
      tool('config', {
        kind: 'config',
        bucket: 'a',
        providerId: 'p1',
        aspect: 'security',
        findings: findings.map((item) => ({ ...item, detail: '' })),
      })
    const ledger = foldLedger([
      request(),
      blind([{ severity: 'blind', title: 'ACL', code: 'blind:acl' }]),
      blind([{ severity: 'ok', title: 'ACL', code: 'acl' }]),
    ])
    expect(ledger.blind).toEqual([])
  })
})

describe('calls, names and evidence', () => {
  it('counts attempts per argument key in the current run only', () => {
    const keyed = (status: 'done' | 'failed') => ({
      ...(tool('config', null, { status }) as Extract<UiEntry, { kind: 'tool' }>),
      key: 'k',
    })
    const ledger = foldLedger([request(), keyed('failed'), request('again'), keyed('failed')])
    expect(ledger.calls.get('k')).toEqual({ attempts: 1, last: 'failed' })
  })
})
