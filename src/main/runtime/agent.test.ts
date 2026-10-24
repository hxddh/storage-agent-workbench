import { describe, expect, it } from 'vitest'
import {
  type AgentState,
  blockReason,
  freshRun,
  groundingCorrection,
  MAX_TOOL_ROUNDS,
} from './agent'

function state(known: string[] = []): AgentState {
  return { digest: '', language: 'en', runs: new Map([['c', freshRun(known)]]) }
}

describe('run guardrails', () => {
  it('blocks a repeated storage read, whatever the key order', () => {
    const s = state()
    expect(blockReason(s, 'c', 'config', { bucket: 'a', aspect: 'security' })).toBeUndefined()
    expect(blockReason(s, 'c', 'config', { aspect: 'security', bucket: 'a' })).toMatch(
      /already ran/,
    )
    expect(blockReason(s, 'c', 'config', { bucket: 'a', aspect: 'lifecycle' })).toBeUndefined()
  })

  it('lets memory be read again as it changes', () => {
    const s = state()
    expect(blockReason(s, 'c', 'estate', {})).toBeUndefined()
    expect(blockReason(s, 'c', 'estate', {})).toBeUndefined()
  })

  it('stops every tool at the round cap', () => {
    const s = state()
    s.runs.get('c')!.rounds = MAX_TOOL_ROUNDS
    expect(blockReason(s, 'c', 'estate', {})).toMatch(/Step budget/)
  })

  it('asks once for a grounded verdict, then lets the window mark it', () => {
    const s = state(['demo'])
    expect(groundingCorrection(s, 'c', '`demo` is public.')).toBeUndefined()
    expect(groundingCorrection(s, 'c', '`demo` and `ghost` are public.')).toMatch(/`ghost`/)
    expect(groundingCorrection(s, 'c', '`ghost` again.')).toBeUndefined()
  })

  it('does not judge a verdict when the task has read nothing it remembers', () => {
    expect(groundingCorrection(state(), 'c', '`anything`')).toBeUndefined()
  })
})
